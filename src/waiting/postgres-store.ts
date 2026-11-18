import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AppError } from "../app/store.ts";
import { waitingCatalog, nextWaitingOpening } from "./config.ts";
import { waitingPool, waitingMigrations, databaseFailure } from "./database.ts";
import { WaitingContactCipher, createWaitingJob, publicWaitingJob } from "./model.ts";
import type { WaitingJob, WaitingState, PrivateWaitingJob, WaitingPatch, WaitingAttempt, WaitingRepository } from "./model.ts";

const LOCK = [0x4f50454e, 0x57414954];
const SELECT = "SELECT *, visit_date::text AS visit_date FROM waiting_requests";
type Row = {
  id: string; restaurant_id: string; visit_date: string; slot: "am" | "pm"; party_size: number;
  phone_ciphertext: string; phone_masked: string; opens_at: Date; prepare_at: Date; runs_at: Date; deadline_at: Date;
  state: WaitingState; notify: boolean; created_at: Date; updated_at: Date;
  message: string | null; result: WaitingJob["result"] | null; notification_state: WaitingJob["notification"] | null;
};
function item(row: Row): PrivateWaitingJob {
  return { id: row.id, restaurantId: row.restaurant_id, visitDate: row.visit_date, slot: row.slot, partySize: row.party_size,
    phoneCiphertext: row.phone_ciphertext, phoneMasked: row.phone_masked, opensAt: row.opens_at.getTime(),
    prepareAt: row.prepare_at.getTime(), runsAt: row.runs_at.getTime(), deadline: row.deadline_at.getTime(),
    state: row.state, notify: row.notify, createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime(),
    message: row.message ?? undefined, result: row.result ?? undefined, notification: row.notification_state ?? undefined };
}
const legal: Partial<Record<WaitingState, WaitingState[]>> = {
  SCHEDULED: ["RUNNING", "CANCELLED", "EXPIRED", "FAILED"],
  RUNNING: ["SUBMITTING", "FAILED", "INTERRUPTED"], SUBMITTING: ["SUCCEEDED", "UNKNOWN"],
};

export class PostgresWaitingStore implements WaitingRepository {
  #pool: Pool; #cipher: WaitingContactCipher; #now: () => number;
  #lease?: PoolClient; #releaseLease?: () => void; #leaseLost = new AbortController();
  #operations: Promise<unknown> = Promise.resolve(); #closing = false; #ending?: Promise<void>;
  constructor(connectionString: string, adminToken: string, now = Date.now) {
    this.#pool = waitingPool(connectionString); this.#cipher = new WaitingContactCipher(adminToken); this.#now = now;
  }
  get executionSignal(): AbortSignal { return this.#leaseLost.signal; }
  catalog() { const now = this.#now(); return { ...waitingCatalog(now), serverTime: now }; }
  async ready() {
    try {
      const applied = await this.#pool.query<{ name: string; checksum: string }>("SELECT name,checksum FROM waiting_schema_migrations");
      for (const migration of await waitingMigrations()) {
        if (!applied.rows.some(row => row.name === migration.name && row.checksum === migration.checksum)) throw new AppError("WAITING_SCHEMA_REQUIRED", 503);
      }
    } catch (error) {
      if ((error as { code?: string }).code === "42P01") throw new AppError("WAITING_SCHEMA_REQUIRED", 503);
      throw databaseFailure(error);
    }
  }
  // A dedicated session fences recovery and execution during overlapping Pod starts.
  // All execution transactions use this same connection, including beforeSubmit.
  async acquireScheduler() {
    await this.#exclusive(async () => {
      if (this.#lease) return;
      if (this.#closing || this.executionSignal.aborted) throw new AppError("WAITING_SCHEDULER_LOCK_LOST", 503);
      const client = await this.#pool.connect().catch(error => { throw databaseFailure(error); });
      let released = false;
      const release = () => { if (!released) { released = true; client.release(true); } };
      const lost = () => {
        if (this.#closing || this.#lease !== client) return;
        this.#loseLease();
      };
      client.once("error", lost); client.once("end", lost);
      try {
        const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1,$2) AS locked", LOCK);
        if (!lock.rows[0].locked) throw new AppError("WAITING_SCHEDULER_BUSY", 503);
        this.#lease = client; this.#releaseLease = release;
      } catch (error) { release(); throw databaseFailure(error); }
    });
  }
  #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#operations.then(action);
    this.#operations = operation.catch(() => {}); return operation;
  }
  #leader(): PoolClient {
    if (!this.#lease || this.executionSignal.aborted || this.#closing) throw new AppError("WAITING_SCHEDULER_LOCK_LOST", 503);
    return this.#lease;
  }
  #loseLease() {
    if (this.#closing || this.executionSignal.aborted) return;
    this.#lease = undefined; this.#releaseLease?.(); this.#leaseLost.abort();
  }
  async #transaction<T>(action: (client: PoolClient) => Promise<T>, leader?: PoolClient): Promise<T> {
    const client = leader ?? await this.#pool.connect().catch(error => { throw databaseFailure(error); });
    try { await client.query("BEGIN"); const result = await action(client); await client.query("COMMIT"); return result; }
    catch (error) {
      const rolledBack = await client.query("ROLLBACK").then(() => true, () => false);
      const serverError = /^[0-9A-Z]{5}$/.test((error as { code?: string }).code ?? "");
      if (leader && (!rolledBack || (!serverError && !(error instanceof AppError)) ||
        error instanceof AppError && error.message === "WAITING_DATABASE_UNAVAILABLE")) this.#loseLease();
      throw databaseFailure(error);
    }
    finally { if (!leader) client.release(); }
  }
  async #read(id: string, client: Pool | PoolClient = this.#pool, lock = false): Promise<PrivateWaitingJob> {
    try {
      const result = await client.query<Row>(`${SELECT} WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
      if (!result.rows.length) throw new AppError("WAITING_NOT_FOUND", 404);
      return item(result.rows[0]);
    } catch (error) { throw databaseFailure(error); }
  }
  async job(id: string) { return publicWaitingJob(await this.#read(id)); }
  async jobs(): Promise<WaitingJob[]> {
    try { return (await this.#pool.query<Row>(`${SELECT} ORDER BY opens_at DESC,created_at DESC,id DESC LIMIT 200`)).rows.map(row => publicWaitingJob(item(row))); }
    catch (error) { throw databaseFailure(error); }
  }
  async pending(): Promise<WaitingJob[]> {
    try { return (await this.#pool.query<Row>(`${SELECT} WHERE state='SCHEDULED' ORDER BY runs_at,id`)).rows.map(row => publicWaitingJob(item(row))); }
    catch (error) { throw databaseFailure(error); }
  }
  async schedule(input: Record<string, unknown>): Promise<WaitingJob> {
    const job = createWaitingJob(input, this.#now(), this.#cipher);
    return this.#transaction(async client => {
      // Serialize this opening's roster so the same phone cannot be added twice.
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [0x524f5354, `${job.restaurantId}:${job.visitDate}:${job.slot}`]);
      if (nextWaitingOpening(this.#now()).id !== input.openingId) throw new AppError("WAITING_OPENING_CHANGED", 409);
      const entries = await client.query<Row>(`${SELECT} WHERE restaurant_id=$1 AND visit_date=$2 AND slot=$3 AND state NOT IN ('CANCELLED','FAILED','EXPIRED')`, [job.restaurantId, job.visitDate, job.slot]);
      const phone = this.#cipher.decrypt(job);
      if (entries.rows.some(row => this.#cipher.decrypt(item(row)) === phone)) throw new AppError("WAITING_ALREADY_EXISTS", 409);
      await client.query(`INSERT INTO waiting_requests
        (id,restaurant_id,visit_date,slot,party_size,phone_ciphertext,phone_masked,opens_at,prepare_at,runs_at,deadline_at,state,notify,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
      [job.id, job.restaurantId, job.visitDate, job.slot, job.partySize, job.phoneCiphertext, job.phoneMasked,
        new Date(job.opensAt), new Date(job.prepareAt), new Date(job.runsAt), new Date(job.deadline), job.state, job.notify, new Date(job.createdAt)]);
      return publicWaitingJob(job);
    });
  }
  async phone(id: string): Promise<string> { return this.#cipher.decrypt(await this.#read(id)); }
  async #change(client: PoolClient, id: string, from: WaitingState[], state: WaitingState, patch: WaitingPatch): Promise<WaitingJob> {
    const previous = await this.#read(id, client, true);
    if (!from.includes(previous.state) || !legal[previous.state]?.includes(state)) throw new AppError("WAITING_STATE_CHANGED", 409);
    const now = new Date(this.#now());
    const updated = await client.query<Row>(`UPDATE waiting_requests SET state=$2,updated_at=$3,
      message=COALESCE($4,message),result=COALESCE($5::jsonb,result) WHERE id=$1 RETURNING *,visit_date::text AS visit_date`,
    [id, state, now, patch.message ?? null, patch.result ? JSON.stringify(patch.result) : null]);
    if (state === "RUNNING") {
      await client.query("INSERT INTO waiting_attempts(id,request_id,state,started_at) VALUES($1,$2,$3,$4)", [randomUUID(), id, state, now]);
    } else if (previous.state === "RUNNING" || previous.state === "SUBMITTING") {
      const attempt = await client.query(`UPDATE waiting_attempts SET state=$2,
        submitted_at=CASE WHEN $2='SUBMITTING' THEN $3 ELSE submitted_at END,
        finished_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED','UNKNOWN','INTERRUPTED') THEN $3 ELSE finished_at END,
        message=COALESCE($4,message),result=COALESCE($5::jsonb,result) WHERE request_id=$1`,
      [id, state, now, patch.message ?? null, patch.result ? JSON.stringify(patch.result) : null]);
      if (attempt.rowCount !== 1) throw new AppError("WAITING_ATTEMPT_MISSING", 500);
    }
    return publicWaitingJob(item(updated.rows[0]));
  }
  async transition(id: string, from: WaitingState[], state: WaitingState, patch: WaitingPatch = {}): Promise<WaitingJob> {
    return this.#exclusive(() => this.#transaction(client => this.#change(client, id, from, state, patch), this.#leader()));
  }
  async cancel(id: string): Promise<WaitingJob> {
    return this.#transaction(client => this.#change(client, id, ["SCHEDULED"], "CANCELLED", {
      message: "자동 실행 신청을 취소했습니다. 이미 시럽에 등록된 웨이팅은 별도로 확인해 주세요.",
    }));
  }
  async notification(id: string, state: "SENT" | "FAILED"): Promise<void> {
    try {
      const result = await this.#pool.query("UPDATE waiting_requests SET notification_state=$2 WHERE id=$1", [id, state]);
      if (!result.rowCount) throw new AppError("WAITING_NOT_FOUND", 404);
    } catch (error) { throw databaseFailure(error); }
  }
  async recover(): Promise<void> {
    await this.#exclusive(() => this.#transaction(async client => {
      const interrupted = await client.query<Row>(`${SELECT} WHERE state IN ('RUNNING','SUBMITTING') ORDER BY id FOR UPDATE`);
      for (const row of interrupted.rows) await this.#change(client, row.id, [row.state], row.state === "SUBMITTING" ? "UNKNOWN" : "INTERRUPTED", {
        message: "실행 중 서버가 재시작됐습니다. 시럽 웨이팅 내역 확인 전 재신청하지 마세요.",
      });
    }, this.#leader()));
  }
  async attempts(id: string): Promise<WaitingAttempt[]> {
    await this.job(id);
    try {
      const result = await this.#pool.query("SELECT * FROM waiting_attempts WHERE request_id=$1 ORDER BY started_at,id", [id]);
      return result.rows.map(row => ({ id: row.id, requestId: row.request_id, state: row.state,
        startedAt: row.started_at.getTime(), submittedAt: row.submitted_at?.getTime(), finishedAt: row.finished_at?.getTime(),
        message: row.message ?? undefined, result: row.result ?? undefined }));
    } catch (error) { throw databaseFailure(error); }
  }
  async close(): Promise<void> {
    return this.#ending ??= (async () => {
      this.#closing = true; await this.#operations;
      if (this.#lease) await this.#lease.query("SELECT pg_advisory_unlock($1,$2)", LOCK).catch(() => {});
      this.#releaseLease?.(); this.#lease = undefined;
      await this.#pool.end(); this.#cipher.close();
    })();
  }
}
