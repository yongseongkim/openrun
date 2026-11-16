import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import * as sqlite from "node:sqlite";
import { WaitingStore } from "../src/waiting/store.ts";
import type { WaitingResult } from "../src/waiting/store.ts";
import { WaitingScheduler } from "../src/waiting/scheduler.ts";
import type { SyrupRunner } from "../src/waiting/syrup.ts";
import { kstDate, tomorrowDate, slotTime } from "../src/waiting/config.ts";
import { AppStore } from "../src/app/store.ts";
import { AuthCoordinator } from "../src/remote/coordinator.ts";
import { remoteConfig } from "../src/remote/config.ts";
import { GrantStore } from "../src/remote/grants.ts";
import { createRemoteServer } from "../src/remote/server.ts";
import { sendWaitingNotification } from "../src/remote/slack.ts";
import { startWaitingService } from "../src/waiting/service.ts";

const token = "test-owner-key-of-at-least-thirty-two-characters";
const phone = "01000001234";
const base = Date.parse("2026-11-03T21:00:00+09:00"); // Tomorrow is Wednesday.
const request = (patch: Record<string, unknown> = {}) => ({ restaurantId: "naniyori", visitDate: "2026-11-04", slot: "am", partySize: 2, phoneNumber: phone, confirmed: true, notify: false, ...patch });
const result: WaitingResult = { waitNumber: "42", teamsAhead: "3", registrationTime: "10:00:03" };
class Runner implements SyrupRunner {
  calls = 0; prepares = 0; closes = 0; mode: "ok" | "lost" | "before" = "ok";
  async prepare() { this.prepares++; }
  async run(input: { partySize: number; phoneNumber: string }, options: { beforeSubmit: () => void | Promise<void>; signal: AbortSignal }) {
    this.calls++; assert.equal(input.phoneNumber, phone);
    if (this.mode === "before") throw new Error("Before final confirmation");
    await options.beforeSubmit();
    if (this.mode === "lost") throw new Error("Result lost after submitting");
    return result;
  }
  async close() { this.closes++; }
}

test("tomorrow and opening times use KST across the UTC date boundary", () => {
  assert.equal(kstDate(Date.parse("2026-11-03T14:59:59Z")), "2026-11-03");
  assert.equal(tomorrowDate(Date.parse("2026-11-03T15:00:00Z")), "2026-11-05");
  assert.equal(new Date(slotTime("2026-11-04", "am")).toISOString(), "2026-11-04T01:00:00.000Z");
  assert.equal(new Date(slotTime("2026-11-04", "pm")).toISOString(), "2026-11-04T07:00:00.000Z");
});

test("waiting requests encrypt contacts, survive reopening, and deduplicate by date/slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openrun-waiting-")), file = join(directory, "state.sqlite");
  let store = new WaitingStore(file, token, () => base);
  try {
    const job = store.schedule(request());
    assert.equal(job.phoneMasked, "010-****-1234");
    assert.equal(JSON.stringify(job).includes(phone), false);
    assert.equal(JSON.stringify(store.jobs()).includes("phoneCiphertext"), false);
    assert.equal(store.phone(job.id), phone);
    assert.throws(() => store.schedule(request({ phoneNumber: "01000005678" })), /WAITING_ALREADY_EXISTS/);
    store.close();
    assert.equal((await readFile(file)).includes(Buffer.from(phone)), false);
    // Simulate a DB written before preparation/attempt timestamps were added.
    const Database = (sqlite as typeof sqlite & { Database: typeof sqlite.DatabaseSync }).Database;
    const legacy = new Database(file);
    const old = JSON.parse(legacy.prepare("SELECT body FROM waiting_jobs WHERE id=?").get(job.id)!.body as string);
    delete old.prepareAt; delete old.runsAt;
    legacy.prepare("UPDATE waiting_jobs SET body=? WHERE id=?").run(JSON.stringify(old), job.id); legacy.close();
    store = new WaitingStore(file, token, () => base);
    assert.equal(store.phone(job.id), phone);
    assert.equal(store.job(job.id).prepareAt, job.opensAt - 120_000);
    assert.equal(store.job(job.id).runsAt, job.opensAt + 1_000);
    store.cancel(job.id);
    assert.equal(store.schedule(request()).state, "SCHEDULED");
    const other = new WaitingStore(file, "a-different-test-key-with-thirty-two-characters", () => base);
    try { assert.throws(() => other.phone(job.id), /WAITING_CONTACT_UNAVAILABLE/); } finally { other.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("only confirmed dates in the next thirty days on configured operating days are accepted", () => {
  let now = base; const store = new WaitingStore(":memory:", token, () => now);
  try {
    assert.throws(() => store.schedule(request({ confirmed: false })), /WAITING_CONFIRMATION_REQUIRED/);
    assert.throws(() => store.schedule(request({ visitDate: "2026-11-03" })), /WAITING_DATE_OUT_OF_RANGE/);
    assert.equal(store.schedule(request({ visitDate: "2026-11-28" })).visitDate, "2026-11-28");
    assert.throws(() => store.schedule(request({ visitDate: "2026-12-04" })), /WAITING_DATE_OUT_OF_RANGE/);
    for (const visitDate of ["2026-11-31", "2026-02-29", "2026-11-4", null]) assert.throws(() => store.schedule(request({ visitDate })), /INVALID_WAITING_DATE/);
    assert.throws(() => store.schedule(request({ slot: "night" })), /INVALID_WAITING_SLOT/);
    assert.throws(() => store.schedule(request({ partySize: 0 })), /INVALID_PARTY_SIZE/);
    assert.throws(() => store.schedule(request({ phoneNumber: "not a phone" })), /INVALID_WAITING_PHONE/);
    now = Date.parse("2026-11-04T21:00:00+09:00");
    assert.throws(() => store.schedule(request({ visitDate: "2026-11-05" })), /WAITING_CLOSED_DAY/);
  } finally { store.close(); }
});

test("scheduler does not submit early, commits SUBMITTING first, and never replays on Slack failure", async () => {
  let now = base, notifications = 0;
  const store = new WaitingStore(":memory:", token, () => now), runner = new Runner();
  const scheduler = new WaitingScheduler(store, runner, { now: () => now, notify: async () => { notifications++; throw new Error("Slack unavailable"); } });
  try {
    const job = store.schedule(request({ notify: true }));
    await scheduler.tick(); assert.equal(runner.prepares, 0);
    now = job.prepareAt - 1; await scheduler.tick(); assert.equal(runner.prepares, 0);
    now = job.prepareAt; await scheduler.tick(); assert.equal(runner.prepares, 1); assert.equal(runner.calls, 0);
    now = job.opensAt; await scheduler.tick(); assert.equal(runner.prepares, 1); assert.equal(runner.calls, 0);
    now = job.runsAt - 1; await scheduler.tick(); assert.equal(runner.calls, 0);
    runner.run = async (_input, options) => { runner.calls++; assert.equal(store.job(job.id).state, "RUNNING"); await options.beforeSubmit(); assert.equal(store.job(job.id).state, "SUBMITTING"); assert.throws(() => store.cancel(job.id), /WAITING_STATE_CHANGED/); return result; };
    now = job.runsAt; await Promise.all([scheduler.tick(), scheduler.tick()]);
    assert.equal(runner.calls, 1); assert.equal(notifications, 1);
    assert.deepEqual(store.job(job.id).result, result); assert.equal(store.job(job.id).state, "SUCCEEDED");
    assert.equal(store.job(job.id).notification, "FAILED");
    assert.equal(runner.closes, 1);
    await scheduler.tick(); assert.equal(runner.calls, 1);
  } finally { await scheduler.close(); store.close(); }
});

test("submission ambiguity and restarts cannot silently retry a waiting registration", async () => {
  let now = base; const store = new WaitingStore(":memory:", token, () => now), runner = new Runner(); runner.mode = "lost";
  const scheduler = new WaitingScheduler(store, runner, { now: () => now });
  try {
    const job = store.schedule(request()); now = job.runsAt;
    await scheduler.tick(); assert.equal(store.job(job.id).state, "UNKNOWN");
    await scheduler.tick(); store.recover(); assert.equal(runner.calls, 1);
    now = base;
    assert.throws(() => store.schedule(request()), /WAITING_ALREADY_EXISTS/);
    const second = store.schedule(request({ slot: "pm" }));
    store.transition(second.id, ["SCHEDULED"], "RUNNING"); store.transition(second.id, ["RUNNING"], "SUBMITTING");
    store.recover(); assert.equal(store.job(second.id).state, "UNKNOWN");
  } finally { await scheduler.close(); store.close(); }
});

test("cancelled and expired requests never open the provider; missed deadlines do not stop later jobs", async () => {
  let now = base; const store = new WaitingStore(":memory:", token, () => now), runner = new Runner();
  const scheduler = new WaitingScheduler(store, runner, { now: () => now });
  try {
    const cancelled = store.schedule(request()); store.cancel(cancelled.id);
    now = cancelled.opensAt; await scheduler.tick(); assert.equal(runner.calls, 0);
    now = base; const morning = store.schedule(request()), afternoon = store.schedule(request({ slot: "pm" }));
    now = morning.deadline + 1; await scheduler.tick(); assert.equal(store.job(morning.id).state, "EXPIRED");
    now = afternoon.runsAt; await scheduler.tick(); assert.equal(store.job(afternoon.id).state, "SUCCEEDED");
    assert.equal(runner.calls, 1);
  } finally { await scheduler.close(); store.close(); }
});

test("cancelling a warmed job releases the browser and later dates still run", async () => {
  let now = base; const store = new WaitingStore(":memory:", token, () => now), runner = new Runner();
  const scheduler = new WaitingScheduler(store, runner, { now: () => now });
  try {
    const first = store.schedule(request()), later = store.schedule(request({ visitDate: "2026-11-06" }));
    now = first.prepareAt; await scheduler.tick(); assert.equal(runner.prepares, 1);
    store.cancel(first.id); await scheduler.tick(); assert.equal(runner.closes, 1); assert.equal(runner.calls, 0);
    now = later.prepareAt; await scheduler.tick(); assert.equal(runner.prepares, 2);
    now = later.runsAt; await scheduler.tick();
    assert.equal(store.job(later.id).state, "SUCCEEDED"); assert.equal(runner.calls, 1); assert.equal(runner.closes, 2);
  } finally { await scheduler.close(); store.close(); }
});

test("waiting-only service persists future requests across restart and executes the next date without Catchtable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openrun-waiting-service-"));
  const databaseFile = join(directory, "state.sqlite");
  let now = base; const runner = new Runner();
  const config = { ...remoteConfig(), port: 0 };
  let service = await startWaitingService({ config, adminToken: token, databaseFile, now: () => now, runner });
  try {
    const address = service.server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(origin + "/healthz")).status, 200);
    assert.equal((await fetch(origin + "/", { redirect: "manual" })).headers.get("location"), "/waiting");
    assert.equal((await fetch(origin + "/api/auth/ensure", { method: "POST" })).status, 404);
    assert.equal((await fetch(origin + "/vendor/novnc/core/rfb.js")).status, 404);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const link = await fetch(origin + "/api/console/link", { method: "POST", headers }).then(r => r.json()) as { url: string };
    assert.equal(new URL(link.url).pathname, "/waiting");
    const response = await fetch(origin + "/api/app/waiting", { method: "POST", headers, body: JSON.stringify(request({ visitDate: "2026-11-06" })) });
    assert.equal(response.status, 201);
    const saved = (await response.json() as { job: { id: string; runsAt: number } }).job;
    assert.equal(runner.prepares, 0);
    await service.stop();
    service = await startWaitingService({ config, adminToken: token, databaseFile, now: () => now, runner });
    await service.scheduler.tick();
    assert.equal(service.store.job(saved.id).state, "SCHEDULED");
    assert.equal(service.store.phone(saved.id), phone);
    now = saved.runsAt; await service.scheduler.tick();
    assert.equal(service.store.job(saved.id).state, "SUCCEEDED"); assert.equal(runner.calls, 1);
  } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("opted-in waiting notifications contain the result without exposing the phone", async t => {
  const store = new WaitingStore(":memory:", token, () => base);
  let payload: Record<string, unknown> | undefined, calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => { calls++; payload = JSON.parse(options.body as string); return new Response("ok"); });
  try {
    const job = store.schedule(request({ notify: true }));
    await sendWaitingNotification("https://hooks.slack.com/services/fixture", { ...job, state: "SUCCEEDED", result });
    const text = JSON.stringify(payload);
    assert.equal(calls, 1); assert.match(text, /42/); assert.equal(text.includes(phone), false); assert.equal(text.includes(job.phoneMasked), false);
    assert.equal(payload?.unfurl_links, false);
  } finally { store.close(); }
});

test("waiting API shares owner authentication, rejects CSRF, and exposes no contact secrets", async () => {
  const app = new AppStore(":memory:"); app.seed();
  const waiting = new WaitingStore(":memory:", token, () => base);
  const coordinator = new AuthCoordinator({ check: async () => true, login: async () => {}, close: async () => {} }, 10000);
  const config = remoteConfig(), server = createRemoteServer({ config, coordinator, grants: new GrantStore(), store: app, waitingStore: waiting, adminToken: token });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); config.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: object, headers: Record<string, string> = {}) => fetch(config.origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(config.origin + "/waiting")).status, 200);
    assert.equal((await fetch(config.origin + "/api/app/waiting")).status, 401);
    const link = await post("/api/console/link", {}, { authorization: `Bearer ${token}` }).then(r => r.json()) as { url: string };
    const secret = new URLSearchParams(new URL(link.url).hash.slice(1)).get("token");
    const exchanged = await post("/api/console/exchange", { token: secret }, { origin: config.origin });
    const cookie = exchanged.headers.get("set-cookie")!.split(";")[0], headers = { cookie, origin: config.origin };
    assert.equal((await post("/api/app/waiting", request(), { cookie })).status, 403);
    const overview = await fetch(config.origin + "/api/app/waiting", { headers }).then(r => r.json()) as { tomorrow: { date: string } };
    assert.equal(overview.tomorrow.date, "2026-11-04");
    const created = await post("/api/app/waiting", request(), headers); assert.equal(created.status, 201);
    const text = await created.text(); assert.equal(text.includes(phone), false); assert.equal(text.includes("phoneCiphertext"), false);
    const id = (JSON.parse(text) as { job: { id: string } }).job.id;
    assert.equal((await post("/api/app/waiting", request(), headers)).status, 409);
    assert.equal((await post(`/api/app/waiting/${id}/cancel`, {}, headers)).status, 200);
    const list = await fetch(config.origin + "/api/app/waiting", { headers }).then(r => r.text());
    assert.equal(list.includes(phone), false); assert.equal(list.includes("phoneCiphertext"), false);
  } finally { await coordinator.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.close(); waiting.close(); }
});
