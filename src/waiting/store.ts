import * as sqlite from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../app/store.ts";
import { NANIYORI, tomorrowDate, isClosed, slotTime, waitingCatalog } from "./config.ts";
import type { WaitingSlot } from "./config.ts";

const Database = (sqlite as typeof sqlite & { Database: typeof sqlite.DatabaseSync }).Database;
export type WaitingState = "SCHEDULED" | "RUNNING" | "SUBMITTING" | "SUCCEEDED" | "UNKNOWN" | "FAILED" | "EXPIRED" | "CANCELLED" | "INTERRUPTED";
export type WaitingResult = { waitNumber: string; teamsAhead: string; registrationTime: string };
export type WaitingJob = {
  id: string; restaurantId: string; visitDate: string; slot: WaitingSlot; partySize: number;
  phoneMasked: string; opensAt: number; deadline: number; state: WaitingState; notify: boolean;
  createdAt: number; updatedAt: number; result?: WaitingResult; message?: string; notification?: "SENT" | "FAILED";
};
type PrivateWaitingJob = WaitingJob & { phoneCiphertext: string };
export class WaitingStore {
  #db: sqlite.DatabaseSync; #key: Buffer; #now: () => number;
  constructor(filename: string, adminToken: string, now = Date.now) {
    if (adminToken.length < 32) throw new AppError("WAITING_KEY_REQUIRED", 500);
    this.#key = createHmac("sha256", adminToken).update("openrun:waiting:phone:v1").digest(); this.#now = now;
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.#db = new Database(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS waiting_jobs (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, visit_date TEXT NOT NULL, slot TEXT NOT NULL, state TEXT NOT NULL, opens_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS waiting_due ON waiting_jobs(state, opens_at);
      CREATE UNIQUE INDEX IF NOT EXISTS waiting_unique_active ON waiting_jobs(restaurant_id, visit_date, slot) WHERE state NOT IN ('CANCELLED', 'FAILED', 'EXPIRED');`);
  }
  #private(id: string): PrivateWaitingJob {
    const row = this.#db.prepare("SELECT body FROM waiting_jobs WHERE id=?").get(id);
    if (!row) throw new AppError("WAITING_NOT_FOUND", 404);
    return JSON.parse(row.body as string);
  }
  #public(item: PrivateWaitingJob): WaitingJob { const { phoneCiphertext: _secret, ...visible } = item; return visible; }
  job(id: string): WaitingJob { return this.#public(this.#private(id)); }
  catalog() { const now = this.#now(); return { ...waitingCatalog(now), serverTime: now }; }
  jobs(): WaitingJob[] { return this.#db.prepare("SELECT body FROM waiting_jobs ORDER BY opens_at DESC, rowid DESC LIMIT 200").all().map(row => this.#public(JSON.parse(row.body as string))); }
  pending(): WaitingJob[] { return this.#db.prepare("SELECT body FROM waiting_jobs WHERE state='SCHEDULED' ORDER BY opens_at, rowid").all().map(row => this.#public(JSON.parse(row.body as string))); }
  schedule(input: Record<string, unknown>): WaitingJob {
    if (input.confirmed !== true) throw new AppError("WAITING_CONFIRMATION_REQUIRED");
    if (input.restaurantId !== NANIYORI.id) throw new AppError("INVALID_WAITING_RESTAURANT");
    const now = this.#now(), date = tomorrowDate(now);
    if (input.visitDate !== date) throw new AppError("WAITING_TOMORROW_ONLY");
    if (isClosed(date)) throw new AppError("WAITING_CLOSED_DAY");
    if (input.slot !== "am" && input.slot !== "pm") throw new AppError("INVALID_WAITING_SLOT");
    const partySize = Number(input.partySize);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > NANIYORI.maxPartySize) throw new AppError("INVALID_PARTY_SIZE");
    if (typeof input.phoneNumber !== "string" || !/^[0-9 -]{10,20}$/.test(input.phoneNumber)) throw new AppError("INVALID_WAITING_PHONE");
    const phone = input.phoneNumber.replace(/[ -]/g, "");
    if (!/^01[016789]\d{7,8}$/.test(phone)) throw new AppError("INVALID_WAITING_PHONE");
    if (input.notify !== undefined && typeof input.notify !== "boolean") throw new AppError("INVALID_NOTIFY");
    const id = randomUUID(), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(phone, "utf8"), cipher.final()]);
    const phoneCiphertext = [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
    const opensAt = slotTime(date, input.slot);
    const item: PrivateWaitingJob = { id, restaurantId: NANIYORI.id, visitDate: date, slot: input.slot, partySize, phoneMasked: `${phone.slice(0, 3)}-****-${phone.slice(-4)}`, phoneCiphertext, opensAt, deadline: opensAt + 120000, state: "SCHEDULED", notify: input.notify === true, createdAt: now, updatedAt: now };
    try {
      this.#db.prepare("INSERT INTO waiting_jobs VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, item.restaurantId, date, item.slot, item.state, opensAt, JSON.stringify(item));
    } catch (error) {
      if ((error as { errcode?: number }).errcode === 2067 || String((error as Error).message).includes("UNIQUE constraint")) throw new AppError("WAITING_ALREADY_EXISTS", 409);
      throw error;
    }
    return this.#public(item);
  }
  phone(id: string): string {
    const item = this.#private(id);
    try {
      const [iv, tag, data] = item.phoneCiphertext.split(".").map(part => Buffer.from(part, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv); decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch { throw new AppError("WAITING_CONTACT_UNAVAILABLE", 500); }
  }
  transition(id: string, from: WaitingState[], state: WaitingState, patch: Partial<Pick<WaitingJob, "message" | "result">> = {}): WaitingJob {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.#private(id);
      if (!from.includes(old.state)) throw new AppError("WAITING_STATE_CHANGED", 409);
      const item = { ...old, ...patch, state, updatedAt: this.#now() };
      this.#db.prepare("UPDATE waiting_jobs SET state=?, body=? WHERE id=?").run(state, JSON.stringify(item), id);
      this.#db.exec("COMMIT"); return this.#public(item);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  cancel(id: string): WaitingJob { return this.transition(id, ["SCHEDULED"], "CANCELLED", { message: "자동 실행 신청을 취소했습니다. 이미 시럽에 등록된 웨이팅은 별도로 확인해 주세요." }); }
  notification(id: string, state: "SENT" | "FAILED") {
    const item = { ...this.#private(id), notification: state };
    this.#db.prepare("UPDATE waiting_jobs SET body=? WHERE id=?").run(JSON.stringify(item), id);
  }
  recover() {
    for (const row of this.#db.prepare("SELECT body FROM waiting_jobs WHERE state IN ('RUNNING','SUBMITTING')").all()) {
      const item = JSON.parse(row.body as string) as WaitingJob;
      this.transition(item.id, [item.state], item.state === "SUBMITTING" ? "UNKNOWN" : "INTERRUPTED", { message: "실행 중 서버가 재시작됐습니다. 시럽 웨이팅 내역 확인 전 재신청하지 마세요." });
    }
  }
  close() { this.#db.close(); this.#key.fill(0); }
}
