import * as sqlite from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CATALOG } from "./catalog.ts";

// Node 26.13 renamed the class; @types/node 26.6.6 still names its identical
// interface DatabaseSync. Keep the runtime on the current, non-deprecated name.
const Database = (sqlite as typeof sqlite & { Database: typeof sqlite.DatabaseSync }).Database;

export class AppError extends Error {
  status: number;
  constructor(code: string, status = 400) { super(code); this.status = status; }
}
export type Restaurant = {
  id: string; name: string; chef: string; area: string; url: string; status: "OPEN" | "PAUSED";
  maxParty: number; notes: string; openingNotes: string; verifiedAt: string | null;
};
export type JobState = "DRAFT" | "SCHEDULED" | "PREPARING" | "NEEDS_LOGIN" | "READY" | "COMPLETED" | "CANCELLED" | "EXPIRED" | "FAILED" | "INTERRUPTED";
export type BookingJob = {
  id: string; restaurantId: string; diningDate: string; diningTime: string; partySize: number;
  opensAt: number; deadline: number; state: JobState; createdAt: number; updatedAt: number;
  requestId?: string; message?: string;
  notify: boolean;
  notification?: "SENT" | "FAILED";
};
const EDITABLE = ["DRAFT", "SCHEDULED", "NEEDS_LOGIN"];
const text = (value: unknown, max: number, required = false) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new AppError("INVALID_TEXT");
  return value.trim();
};
export function restaurantUrl(value: unknown): string {
  if (typeof value !== "string") throw new AppError("INVALID_RESTAURANT_URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("INVALID_RESTAURANT_URL"); }
  if (url.origin !== "https://app.catchtable.co.kr" || url.username || url.password || !/^\/ct\/shop\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) throw new AppError("INVALID_RESTAURANT_URL");
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}
export class AppStore {
  #db: sqlite.DatabaseSync;
  #now: () => number;
  constructor(filename: string, now = Date.now) {
    this.#now = now;
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.#db = new Database(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS restaurants (id TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, state TEXT NOT NULL, opens_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, opens_at);
      PRAGMA user_version=1;`);
  }
  seed() {
    const insert = this.#db.prepare("INSERT OR IGNORE INTO restaurants VALUES (?, ?, ?)");
    for (const row of CATALOG) {
      const { slug, ...fields } = row;
      const item: Restaurant = { ...fields, id: slug, url: `https://app.catchtable.co.kr/ct/shop/${slug}`, verifiedAt: "2026-11-02T17:25:00+09:00" };
      insert.run(item.id, item.url, JSON.stringify(item));
    }
  }
  restaurants(): Restaurant[] { return this.#db.prepare("SELECT body FROM restaurants ORDER BY rowid").all().map(row => JSON.parse(row.body as string)); }
  restaurant(id: string): Restaurant {
    const row = this.#db.prepare("SELECT body FROM restaurants WHERE id=?").get(id);
    if (!row) throw new AppError("RESTAURANT_NOT_FOUND", 404);
    return JSON.parse(row.body as string);
  }
  saveRestaurant(input: Record<string, unknown>, id?: string): Restaurant {
    const old = id ? this.restaurant(id) : undefined;
    const maxParty = Number(input.maxParty);
    if (!Number.isInteger(maxParty) || maxParty < 1 || maxParty > 80) throw new AppError("INVALID_PARTY_SIZE");
    if (!["OPEN", "PAUSED"].includes(String(input.status))) throw new AppError("INVALID_RESTAURANT_STATUS");
    const item: Restaurant = {
      id: id ?? randomUUID(), name: text(input.name, 100, true), chef: text(input.chef, 100), area: text(input.area, 100),
      url: restaurantUrl(input.url), status: input.status as Restaurant["status"], maxParty,
      notes: text(input.notes, 1500), openingNotes: text(input.openingNotes, 1000), verifiedAt: old?.url === restaurantUrl(input.url) ? old.verifiedAt : null,
    };
    if (this.restaurants().some(r => r.url === item.url && r.id !== item.id)) throw new AppError("RESTAURANT_ALREADY_EXISTS", 409);
    if (id) {
      if (this.jobs().some(j => j.restaurantId === id && ["SCHEDULED", "PREPARING", "READY", "NEEDS_LOGIN"].includes(j.state))) throw new AppError("RESTAURANT_HAS_ACTIVE_JOBS", 409);
      this.#db.prepare("UPDATE restaurants SET url=?, body=? WHERE id=?").run(item.url, JSON.stringify(item), item.id);
    } else this.#db.prepare("INSERT INTO restaurants VALUES (?, ?, ?)").run(item.id, item.url, JSON.stringify(item));
    return item;
  }
  jobs(): BookingJob[] { return this.#db.prepare("SELECT body FROM jobs ORDER BY opens_at DESC, rowid DESC").all().map(row => JSON.parse(row.body as string)); }
  job(id: string): BookingJob {
    const row = this.#db.prepare("SELECT body FROM jobs WHERE id=?").get(id);
    if (!row) throw new AppError("BOOKING_NOT_FOUND", 404);
    return JSON.parse(row.body as string);
  }
  draft(input: Record<string, unknown>): BookingJob {
    const restaurant = this.restaurant(String(input.restaurantId));
    if (restaurant.status !== "OPEN") throw new AppError("RESTAURANT_PAUSED", 409);
    const diningDate = text(input.diningDate, 10, true), diningTime = text(input.diningTime, 5, true);
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(diningDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(diningTime)) throw new AppError("INVALID_DINING_TIME");
    const diningAt = Date.parse(`${diningDate}T${diningTime}:00+09:00`);
    if (!Number.isFinite(diningAt) || new Date(diningAt + 9 * 3600000).toISOString().slice(0, 10) !== diningDate || diningAt <= this.#now()) throw new AppError("INVALID_DINING_TIME");
    const partySize = Number(input.partySize);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > restaurant.maxParty) throw new AppError("INVALID_PARTY_SIZE");
    if (typeof input.opensAt !== "string" || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(input.opensAt)) throw new AppError("TIMEZONE_REQUIRED");
    const opensAt = Date.parse(input.opensAt);
    if (!Number.isFinite(opensAt) || opensAt >= diningAt || opensAt < this.#now() - 60_000 || opensAt > this.#now() + 366 * 86400000) throw new AppError("INVALID_OPENING_TIME");
    const now = this.#now();
    if (input.notify !== undefined && typeof input.notify !== "boolean") throw new AppError("INVALID_NOTIFY");
    const item: BookingJob = { id: randomUUID(), restaurantId: restaurant.id, diningDate, diningTime, partySize, opensAt, deadline: Math.min(opensAt + 10 * 60_000, diningAt), state: "DRAFT", createdAt: now, updatedAt: now, notify: input.notify === true };
    if (this.jobs().some(j => j.restaurantId === item.restaurantId && j.diningDate === diningDate && j.diningTime === diningTime && j.partySize === partySize && !["CANCELLED", "EXPIRED", "FAILED"].includes(j.state))) throw new AppError("BOOKING_ALREADY_EXISTS", 409);
    this.#db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?)").run(item.id, item.restaurantId, item.state, item.opensAt, JSON.stringify(item));
    return item;
  }
  transition(id: string, from: JobState[], state: JobState, patch: Partial<Pick<BookingJob, "requestId" | "message">> = {}): BookingJob {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.job(id);
      if (!from.includes(old.state)) throw new AppError("BOOKING_STATE_CHANGED", 409);
      const item = { ...old, ...patch, state, updatedAt: this.#now() };
      this.#db.prepare("UPDATE jobs SET state=?, body=? WHERE id=?").run(state, JSON.stringify(item), id);
      this.#db.exec("COMMIT"); return item;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  arm(id: string): BookingJob {
    const item = this.job(id);
    if (this.restaurant(item.restaurantId).status !== "OPEN") throw new AppError("RESTAURANT_PAUSED", 409);
    if (item.opensAt < this.#now() - 60_000) throw new AppError("OPENING_TIME_PASSED", 409);
    // A single account/browser can handle one ten-minute reservation window.
    if (this.jobs().some(j => j.id !== id && ["SCHEDULED", "PREPARING", "READY", "NEEDS_LOGIN"].includes(j.state) && j.opensAt < item.deadline && item.opensAt < j.deadline)) throw new AppError("BOOKING_WINDOW_CONFLICT", 409);
    return this.transition(id, ["DRAFT"], "SCHEDULED");
  }
  cancel(id: string): BookingJob { return this.transition(id, EDITABLE as JobState[], "CANCELLED", { message: "실행 요청을 취소했습니다. 캐치테이블에서 확정된 예약 취소와는 별개입니다." }); }
  claim(id: string): BookingJob { return this.transition(id, ["SCHEDULED", "NEEDS_LOGIN"], "PREPARING"); }
  notification(id: string, state: "SENT" | "FAILED") {
    const item = { ...this.job(id), notification: state };
    this.#db.prepare("UPDATE jobs SET body=? WHERE id=?").run(JSON.stringify(item), id);
  }
  recover() {
    for (const item of this.jobs()) {
      if (item.state === "PREPARING" || item.state === "READY") this.transition(item.id, [item.state], "INTERRUPTED", { message: "서버가 재시작되었습니다. 중복 예약을 막기 위해 캐치테이블 예약 내역 확인 후 새 요청을 등록해 주세요." });
    }
  }
  close() { this.#db.close(); }
}
