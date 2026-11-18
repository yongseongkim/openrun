// SQLite adapter retained for local fixtures and existing combined deployments.
// Production waiting-only deployments use PostgresWaitingStore.
import * as sqlite from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../app/store.ts";
import { waitingCatalog } from "./config.ts";
import { WaitingContactCipher, createWaitingJob, publicWaitingJob, waitingOpening, waitingPartySize } from "./model.ts";
import type { WaitingJob, WaitingState, PrivateWaitingJob, WaitingPatch, WaitingRepository } from "./model.ts";
export type { WaitingJob, WaitingState, WaitingResult } from "./model.ts";

const Database = (sqlite as typeof sqlite & { Database: typeof sqlite.DatabaseSync }).Database;
export class WaitingStore implements WaitingRepository {
  #db: sqlite.DatabaseSync; #cipher: WaitingContactCipher; #now: () => number;
  constructor(filename: string, adminToken: string, now = Date.now) {
    this.#cipher = new WaitingContactCipher(adminToken); this.#now = now;
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.#db = new Database(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS waiting_jobs (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, visit_date TEXT NOT NULL, slot TEXT NOT NULL, state TEXT NOT NULL, opens_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS waiting_due ON waiting_jobs(state, opens_at);
      DROP INDEX IF EXISTS waiting_unique_active;
      CREATE INDEX IF NOT EXISTS waiting_roster ON waiting_jobs(restaurant_id, visit_date, slot) WHERE state NOT IN ('CANCELLED', 'FAILED', 'EXPIRED');`);
  }
  #private(id: string): PrivateWaitingJob {
    const row = this.#db.prepare("SELECT body FROM waiting_jobs WHERE id=?").get(id);
    if (!row) throw new AppError("WAITING_NOT_FOUND", 404);
    return JSON.parse(row.body as string);
  }
  job(id: string): WaitingJob { return publicWaitingJob(this.#private(id)); }
  catalog() { const now = this.#now(); return { ...waitingCatalog(now), serverTime: now }; }
  jobs(): WaitingJob[] { return this.#db.prepare("SELECT body FROM waiting_jobs ORDER BY opens_at DESC, rowid DESC LIMIT 200").all().map(row => publicWaitingJob(JSON.parse(row.body as string))); }
  pending(): WaitingJob[] { return this.#db.prepare("SELECT body FROM waiting_jobs WHERE state='SCHEDULED' ORDER BY opens_at, rowid").all().map(row => publicWaitingJob(JSON.parse(row.body as string))); }
  schedule(input: Record<string, unknown>): WaitingJob {
    const item = createWaitingJob(input, this.#now(), this.#cipher);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const phone = this.#cipher.decrypt(item);
      const entries = this.#db.prepare("SELECT body FROM waiting_jobs WHERE restaurant_id=? AND visit_date=? AND slot=? AND state NOT IN ('CANCELLED','FAILED','EXPIRED')").all(item.restaurantId, item.visitDate, item.slot);
      const previous = entries.map(row => JSON.parse(row.body as string) as PrivateWaitingJob).find(row => this.#cipher.decrypt(row) === phone);
      if (previous) {
        const updated = this.#resize(previous, input);
        this.#db.exec("COMMIT"); return updated;
      }
      this.#db.prepare("INSERT INTO waiting_jobs VALUES (?, ?, ?, ?, ?, ?, ?)").run(item.id, item.restaurantId, item.visitDate, item.slot, item.state, item.opensAt, JSON.stringify(item));
      this.#db.exec("COMMIT"); return publicWaitingJob(item);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #resize(previous: PrivateWaitingJob, input: Record<string, unknown>): WaitingJob {
    const opening = waitingOpening(input, this.#now()), partySize = waitingPartySize(input.partySize);
    if (previous.opensAt !== opening.opensAt) throw new AppError("WAITING_OPENING_CHANGED", 409);
    if (previous.state !== "SCHEDULED") throw new AppError("WAITING_STATE_CHANGED", 409);
    const updated = { ...previous, partySize, updatedAt: this.#now() };
    this.#db.prepare("UPDATE waiting_jobs SET body=? WHERE id=?").run(JSON.stringify(updated), previous.id);
    return publicWaitingJob(updated);
  }
  resize(id: string, input: Record<string, unknown>): WaitingJob {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const updated = this.#resize(this.#private(id), input); this.#db.exec("COMMIT"); return updated; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  phone(id: string): string { return this.#cipher.decrypt(this.#private(id)); }
  transition(id: string, from: WaitingState[], state: WaitingState, patch: WaitingPatch = {}): WaitingJob {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.#private(id);
      if (!from.includes(old.state)) throw new AppError("WAITING_STATE_CHANGED", 409);
      const item = { ...old, ...patch, state, updatedAt: this.#now() };
      this.#db.prepare("UPDATE waiting_jobs SET state=?, body=? WHERE id=?").run(state, JSON.stringify(item), id);
      this.#db.exec("COMMIT"); return publicWaitingJob(item);
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
  close() { this.#db.close(); this.#cipher.close(); }
}
