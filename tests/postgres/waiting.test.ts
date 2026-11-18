import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { once } from "node:events";
import { Pool } from "pg";
import { waitingPool, migrateWaitingDatabase } from "../../src/waiting/database.ts";
import { PostgresWaitingStore } from "../../src/waiting/postgres-store.ts";
import { WaitingScheduler } from "../../src/waiting/scheduler.ts";
import { AppError } from "../../src/app/store.ts";

const connection = process.env.OPENRUN_TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.startsWith("/openrun_test")) throw new Error("Use npm run test:postgres with its disposable database");
const root = new Pool({ connectionString: connection }); after(async () => { await root.end(); });
const key = "postgres-fixture-owner-key-of-at-least-thirty-two-characters";
const phone = "01000001234", base = Date.parse("2026-11-03T21:00:00+09:00");
const input = (patch: Record<string, unknown> = {}) => ({ openingId: "2026-11-04:am:10:00", partySize: 2, phoneNumber: phone, confirmed: true, notify: false, ...patch });
const result = { waitNumber: "42", teamsAhead: "3", registrationTime: "10:00:03" };
type Fixture = { pool: Pool; clock: { now: number }; store: PostgresWaitingStore; make: (token?: string) => PostgresWaitingStore };
async function fixture(action: (value: Fixture) => Promise<void>) {
  const schema = "openrun_test_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection!); url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = waitingPool(url.href), stores: PostgresWaitingStore[] = [], clock = { now: base };
  const make = (token = key) => { const store = new PostgresWaitingStore(url.href, token, () => clock.now); stores.push(store); return store; };
  try { await migrateWaitingDatabase(pool); await action({ pool, clock, make, store: make() }); }
  finally {
    await Promise.all(stores.map(store => store.close())); await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

test("PostgreSQL persists encrypted requests and exact KST times across connections", () => fixture(async ({ pool, store, make }) => {
  const job = await store.schedule(input());
  const reopened = make(); await reopened.ready();
  assert.equal(await reopened.phone(job.id), phone);
  assert.equal((await reopened.job(job.id)).visitDate, "2026-11-04");
  assert.equal(new Date(job.prepareAt).toISOString(), "2026-11-04T00:58:00.000Z");
  assert.equal(new Date(job.runsAt).toISOString(), "2026-11-04T01:00:01.000Z");
  const persisted = (await pool.query("SELECT * FROM waiting_requests WHERE id=$1", [job.id])).rows[0];
  assert.equal(JSON.stringify(persisted).includes(phone), false);
  assert.equal(JSON.stringify(await reopened.jobs()).includes("phoneCiphertext"), false);
  await assert.rejects(make("different-key-of-at-least-thirty-two-characters").phone(job.id), /WAITING_CONTACT_UNAVAILABLE/);
  await assert.rejects(store.schedule(input({ openingId: "2026-11-31:am" })), /WAITING_OPENING_CHANGED/);
}));

test("a roster accepts different phones but concurrent duplicate phones have one winner", () => fixture(async ({ store, make }) => {
  const other = make();
  const attempts = await Promise.allSettled([store.schedule(input()), other.schedule(input())]);
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
  const rejected = attempts.find(item => item.status === "rejected") as PromiseRejectedResult;
  assert.match(rejected.reason.message, /WAITING_ALREADY_EXISTS/);
  const [original] = await store.jobs();
  // Identical masks still belong to different full phone numbers.
  const another = await other.schedule(input({ phoneNumber: "01099991234" }));
  assert.equal(another.phoneMasked, original.phoneMasked);
  await other.cancel(original.id);
  const next = await store.schedule(input()); assert.notEqual(next.id, original.id);
  assert.equal((await store.jobs()).length, 3);
}));

test("schema migrations serialize, are repeatable, and reject checksum changes", () => fixture(async ({ pool }) => {
  await Promise.all([migrateWaitingDatabase(pool), migrateWaitingDatabase(pool)]);
  assert.equal((await pool.query("SELECT * FROM waiting_schema_migrations")).rowCount, 2);
  await pool.query("UPDATE waiting_schema_migrations SET checksum='changed'");
  await assert.rejects(migrateWaitingDatabase(pool), /WAITING_MIGRATION_CHANGED/);
  assert.equal((await pool.query("SELECT count(*) FROM waiting_requests")).rows[0].count, "0");
}));

test("one scheduler owns recovery; restart preserves uncertain submissions and their history", () => fixture(async ({ store, make }) => {
  await store.acquireScheduler();
  const other = make(); await assert.rejects(other.acquireScheduler(), /WAITING_SCHEDULER_BUSY/);
  const first = await store.schedule(input()), second = await store.schedule(input({ phoneNumber: "01000005678" }));
  await store.transition(first.id, ["SCHEDULED"], "RUNNING");
  await store.transition(second.id, ["SCHEDULED"], "RUNNING");
  await store.transition(second.id, ["RUNNING"], "SUBMITTING");
  await assert.rejects(other.recover(), /WAITING_SCHEDULER_LOCK_LOST/);
  assert.equal((await other.job(first.id)).state, "RUNNING");
  await store.close(); await other.acquireScheduler(); await other.recover();
  assert.equal((await other.job(first.id)).state, "INTERRUPTED");
  assert.equal((await other.job(second.id)).state, "UNKNOWN");
  assert.equal((await other.attempts(second.id))[0].state, "UNKNOWN");
  await assert.rejects(other.schedule(input({ phoneNumber: "01000005678" })), /WAITING_ALREADY_EXISTS/);
}));

test("competing claims create one attempt; request and attempt changes commit together", () => fixture(async ({ pool, store }) => {
  await store.acquireScheduler(); const job = await store.schedule(input());
  const claims = await Promise.allSettled([store.transition(job.id, ["SCHEDULED"], "RUNNING"), store.transition(job.id, ["SCHEDULED"], "RUNNING")]);
  assert.equal(claims.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((await store.attempts(job.id)).length, 1);
  await store.transition(job.id, ["RUNNING"], "FAILED");
  const next = await store.schedule(input());
  await pool.query("CREATE FUNCTION reject_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$");
  await pool.query("CREATE TRIGGER reject_attempt BEFORE INSERT ON waiting_attempts FOR EACH ROW EXECUTE FUNCTION reject_attempt()");
  await assert.rejects(store.transition(next.id, ["SCHEDULED"], "RUNNING"), /WAITING_DATABASE_UNAVAILABLE/);
  assert.equal((await store.job(next.id)).state, "SCHEDULED");
  assert.equal((await store.attempts(next.id)).length, 0);
}));

test("a failed SUBMITTING transaction prevents the final provider action", () => fixture(async ({ pool, store, clock }) => {
  await store.acquireScheduler(); const job = await store.schedule(input());
  await pool.query("CREATE FUNCTION reject_submit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='SUBMITTING' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$");
  await pool.query("CREATE TRIGGER reject_submit BEFORE UPDATE ON waiting_attempts FOR EACH ROW EXECUTE FUNCTION reject_submit()");
  let finalActions = 0;
  const scheduler = new WaitingScheduler(store, { prepare: async () => {}, close: async () => {}, run: async (_input, options) => {
    await options.beforeSubmit(); finalActions++; return result;
  } }, { now: () => clock.now });
  try {
    clock.now = job.runsAt; await scheduler.tick();
    assert.equal(finalActions, 0); assert.equal((await store.job(job.id)).state, "FAILED");
    const attempt = (await store.attempts(job.id))[0];
    assert.equal(attempt.state, "FAILED"); assert.equal(attempt.submittedAt, undefined); assert.ok(attempt.finishedAt);
  } finally { await scheduler.close(); }
}));

test("PostgreSQL scheduling waits for +1 second and notification storage failure cannot replay success", () => fixture(async ({ pool, store, clock }) => {
  await store.acquireScheduler(); const job = await store.schedule(input({ notify: true }));
  let preparations = 0, actions = 0, notifications = 0;
  const scheduler = new WaitingScheduler(store, { prepare: async () => { preparations++; }, close: async () => {}, run: async (details, options) => {
    assert.equal(details.phoneNumber, phone); await options.beforeSubmit();
    // A different connection must see the durable boundary before the provider action.
    assert.equal((await pool.query("SELECT state FROM waiting_requests WHERE id=$1", [job.id])).rows[0].state, "SUBMITTING");
    actions++; return result;
  } }, { now: () => clock.now, notify: async () => { notifications++; } });
  store.notification = async () => { throw new AppError("WAITING_DATABASE_UNAVAILABLE", 503); };
  try {
    clock.now = job.prepareAt; await scheduler.tick(); assert.equal(preparations, 1);
    clock.now = job.opensAt; await scheduler.tick(); assert.equal(actions, 0);
    clock.now = job.runsAt; await scheduler.tick();
    assert.equal((await store.job(job.id)).state, "SUCCEEDED");
    assert.deepEqual((await store.attempts(job.id))[0].result, result);
    await scheduler.tick(); assert.equal(actions, 1); assert.equal(notifications, 1);
  } finally { await scheduler.close(); }
}));

test("independent notification updates cannot overwrite a committed execution state", () => fixture(async ({ store, make }) => {
  await store.acquireScheduler(); const job = await store.schedule(input());
  const other = make();
  await Promise.all([store.transition(job.id, ["SCHEDULED"], "RUNNING"), other.notification(job.id, "SENT")]);
  const current = await store.job(job.id);
  assert.equal(current.state, "RUNNING"); assert.equal(current.notification, "SENT");
}));

test("loss of the scheduler database session revokes execution and next owner recovers UNKNOWN", () => fixture(async ({ pool, store, make }) => {
  await store.acquireScheduler(); const job = await store.schedule(input());
  await store.transition(job.id, ["SCHEDULED"], "RUNNING");
  await store.transition(job.id, ["RUNNING"], "SUBMITTING");
  const locks = await pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1 AND objid=$2 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())", [0x4f50454e, 0x57414954]);
  assert.equal(locks.rowCount, 1);
  const lost = once(store.executionSignal, "abort", { signal: AbortSignal.timeout(3000) });
  await pool.query("SELECT pg_terminate_backend($1)", [locks.rows[0].pid]); await lost;
  await assert.rejects(store.transition(job.id, ["SUBMITTING"], "SUCCEEDED", { result }), /WAITING_SCHEDULER_LOCK_LOST/);
  const next = make(); await next.acquireScheduler(); await next.recover();
  assert.equal((await next.job(job.id)).state, "UNKNOWN");
  assert.equal((await next.attempts(job.id))[0].state, "UNKNOWN");
}));

test("runtime works with only table DML privileges and cannot create schema objects", () => fixture(async ({ pool, clock }) => {
  const schema = (await pool.query("SELECT current_schema() AS name")).rows[0].name as string;
  const role = "openrun_test_role_" + randomUUID().replaceAll("-", ""), password = randomBytes(16).toString("hex");
  await root.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  const url = new URL(connection!); url.username = role; url.password = password; url.searchParams.set("options", `-c search_path=${schema}`);
  const restricted = new PostgresWaitingStore(url.href, key, () => clock.now), restrictedPool = waitingPool(url.href);
  try {
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await pool.query(`GRANT SELECT ON waiting_schema_migrations TO ${role}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE ON waiting_requests, waiting_attempts TO ${role}`);
    await restricted.ready(); await restricted.acquireScheduler();
    const job = await restricted.schedule(input());
    await restricted.transition(job.id, ["SCHEDULED"], "RUNNING");
    await restricted.transition(job.id, ["RUNNING"], "SUBMITTING");
    await restricted.transition(job.id, ["SUBMITTING"], "SUCCEEDED", { result });
    assert.equal((await restricted.job(job.id)).state, "SUCCEEDED");
    assert.deepEqual((await restricted.attempts(job.id))[0].result, result);
    await assert.rejects(restrictedPool.query("CREATE TABLE forbidden_ddl(id integer)"), (error: unknown) => (error as { code: string }).code === "42501");
  } finally {
    await restricted.close(); await restrictedPool.end();
    await root.query(`DROP OWNED BY ${role}`); await root.query(`DROP ROLE ${role}`);
  }
}));
