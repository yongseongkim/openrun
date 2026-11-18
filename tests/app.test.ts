import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { AppStore, restaurantUrl } from "../src/app/store.ts";
import { BookingScheduler } from "../src/app/scheduler.ts";
import { AuthCoordinator } from "../src/remote/coordinator.ts";
import type { AuthWorker } from "../src/remote/worker.ts";
import { remoteConfig } from "../src/remote/config.ts";
import { GrantStore } from "../src/remote/grants.ts";
import { createRemoteServer, loginLink } from "../src/remote/server.ts";

const input = (now: number, patch: Record<string, unknown> = {}) => ({ restaurantId: "notre", diningDate: new Date(now + 30 * 86400000).toISOString().slice(0, 10), diningTime: "18:00", partySize: 2, opensAt: new Date(now + 60000).toISOString(), ...patch });
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Fixture did not settle"); await delay(5); }
}
class Worker implements AuthWorker {
  calls = 0; pages = 0;
  async check() { this.calls++; return true; }
  async login() { throw new Error("Unexpected login"); }
  async close() {}
  async withAuthenticatedPage<T>(action: (page: Page) => Promise<T>): Promise<T> { this.pages++; return action({} as Page); }
}

test("catalog and drafts persist; arming, cancellation and claiming cannot replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openrun-store-")), file = join(directory, "app.sqlite");
  let now = Date.now(), store = new AppStore(file, () => now);
  try {
    store.seed(); store.seed(); assert.equal(store.restaurants().length, 3);
    assert.equal(store.restaurant("viatoledo").name, "베수비오");
    const draft = store.draft(input(now)); assert.equal(draft.state, "DRAFT");
    assert.throws(() => store.draft(input(now)), /BOOKING_ALREADY_EXISTS/);
    store.close(); store = new AppStore(file, () => now);
    assert.equal(store.job(draft.id).state, "DRAFT");
    store.arm(draft.id); assert.throws(() => store.arm(draft.id), /BOOKING_STATE_CHANGED/);
    const conflict = store.draft(input(now, { restaurantId: "viatoledo" }));
    assert.throws(() => store.arm(conflict.id), /BOOKING_WINDOW_CONFLICT/);
    store.cancel(conflict.id); assert.throws(() => store.claim(conflict.id), /BOOKING_STATE_CHANGED/);
    store.claim(draft.id); assert.throws(() => store.claim(draft.id), /BOOKING_STATE_CHANGED/);
    store.close(); store = new AppStore(file, () => now); store.recover();
    assert.equal(store.job(draft.id).state, "INTERRUPTED");
    store.recover(); assert.equal(store.job(draft.id).state, "INTERRUPTED");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("requests reject paused venues, invalid dates, unzoned opening times and external URLs", () => {
  const now = Date.now(), store = new AppStore(":memory:", () => now); store.seed();
  try {
    store.saveRestaurant({ ...store.restaurant("tempmosuseoul"), status: "PAUSED" }, "tempmosuseoul");
    assert.throws(() => store.draft(input(now, { restaurantId: "tempmosuseoul" })), /RESTAURANT_PAUSED/);
    assert.throws(() => store.draft(input(now, { diningDate: "2027-02-30" })), /INVALID_DINING_TIME/);
    assert.throws(() => store.draft(input(now, { opensAt: "2026-12-01T10:00:00" })), /TIMEZONE_REQUIRED/);
    assert.throws(() => store.draft(input(now, { partySize: 7 })), /INVALID_PARTY_SIZE/);
    for (const url of ["http://app.catchtable.co.kr/ct/shop/notre", "https://attacker.example/ct/shop/notre", "https://app.catchtable.co.kr/ct/shop/notre/../../login", "https://user@app.catchtable.co.kr/ct/shop/notre"]) assert.throws(() => restaurantUrl(url));
    assert.equal(restaurantUrl("https://app.catchtable.co.kr/ct/shop/notre?token=discard#discard"), "https://app.catchtable.co.kr/ct/shop/notre");
  } finally { store.close(); }
});

test("scheduler checks login ten minutes before opening, waits to prepare, and never replays on notification failure", async () => {
  let now = Date.now(), prepares = 0, notifications = 0;
  const store = new AppStore(":memory:", () => now); store.seed();
  const worker = new Worker(), coordinator = new AuthCoordinator(worker, 60000);
  const scheduler = new BookingScheduler(store, coordinator, { now: () => now, prepare: async () => { prepares++; }, ready: async () => { notifications++; throw new Error("Offline notification"); } });
  try {
    const job = store.draft(input(now, { notify: true, opensAt: new Date(now + 11 * 60_000).toISOString() }));
    await scheduler.tick(); assert.equal(worker.calls, 0);
    store.arm(job.id);
    now = job.opensAt - 600_001;
    await scheduler.tick(); assert.equal(worker.calls, 0);
    now++;
    await scheduler.tick(); await until(() => worker.calls === 1);
    await scheduler.tick(); assert.equal(prepares, 0);
    now = job.opensAt - 1;
    await scheduler.tick(); assert.equal(prepares, 0); assert.equal(worker.pages, 0);
    now = job.opensAt;
    const running = scheduler.tick(); await until(() => store.job(job.id).state === "READY");
    assert.equal(prepares, 1); assert.equal(notifications, 1);
    await until(() => store.job(job.id).notification === "FAILED");
    assert.equal(scheduler.tick(), running);
    assert.throws(() => coordinator.ensure(), { code: "BROWSER_BUSY" });
    const requestId = store.job(job.id).requestId!;
    assert.equal(coordinator.canControl(requestId), true);
    coordinator.finishReservation(requestId); await running;
    assert.equal(store.job(job.id).state, "COMPLETED");
    assert.equal(coordinator.canControl(requestId), false);
    await scheduler.tick(); assert.equal(worker.pages, 1);
    assert.equal(prepares, 1); assert.equal(notifications, 1);
  } finally { await scheduler.close(); await coordinator.close(); store.close(); }
});

test("missed deadlines expire without opening a page; READY recovery requires manual review", async () => {
  let now = Date.now(); const store = new AppStore(":memory:", () => now); store.seed();
  const worker = new Worker(), coordinator = new AuthCoordinator(worker, 60000), scheduler = new BookingScheduler(store, coordinator, { now: () => now });
  try {
    const job = store.draft(input(now)); store.arm(job.id); now = job.deadline + 1;
    await scheduler.tick(); assert.equal(store.job(job.id).state, "EXPIRED"); assert.equal(worker.pages, 0);
    const other = store.draft(input(now, { restaurantId: "viatoledo" })); store.arm(other.id); store.claim(other.id); store.transition(other.id, ["PREPARING"], "READY");
    store.recover(); assert.equal(store.job(other.id).state, "INTERRUPTED");
  } finally { await scheduler.close(); await coordinator.close(); store.close(); }
});

test("owner console protects CRUD and scheduling; viewer links never grant owner access", async () => {
  const store = new AppStore(":memory:"); store.seed();
  const worker = new Worker(), coordinator = new AuthCoordinator(worker, 60000), grants = new GrantStore();
  const config = remoteConfig(), token = "test-admin-token-with-sufficient-random-length";
  const server = createRemoteServer({ config, coordinator, grants, adminToken: token, store });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  config.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: object, headers: Record<string, string> = {}, method = "POST") => fetch(config.origin + path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(config.origin + "/api/app")).status, 401);
    const minted = await post("/api/console/link", {}, { authorization: `Bearer ${token}` });
    const link = new URL((await minted.json() as { url: string }).url);
    const ownerToken = new URLSearchParams(link.hash.slice(1)).get("token")!;
    await fetch(link.origin); await fetch(link.origin);
    assert.equal((await post("/api/console/exchange", { token: ownerToken }, { origin: "https://other.example" })).status, 403);
    const exchanged = await post("/api/console/exchange", { token: ownerToken }, { origin: config.origin });
    assert.equal(exchanged.status, 200);
    assert.match(exchanged.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    const cookie = exchanged.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await post("/api/console/exchange", { token: ownerToken }, { origin: config.origin })).status, 401);
    const headers = { cookie, origin: config.origin };
    const list = await fetch(config.origin + "/api/app", { headers });
    assert.equal((await list.json() as { restaurants: unknown[] }).restaurants.length, 3);
    assert.equal((await post("/api/app/jobs", input(Date.now()), { cookie })).status, 403);
    const response = await post("/api/app/jobs", input(Date.now()), headers);
    const job = (await response.json() as { job: { id: string } }).job;
    assert.equal(response.status, 201);
    assert.equal((await post(`/api/app/jobs/${job.id}/arm`, {}, headers)).status, 400);
    assert.equal((await post(`/api/app/jobs/${job.id}/arm`, { confirmed: true }, headers)).status, 200);
    assert.equal((await post(`/api/app/jobs/${job.id}/cancel`, {}, headers)).status, 200);
    const login = coordinator.ensure(); await coordinator.wait(login.id);
    const viewerLink = new URL(loginLink(config.origin, grants, coordinator.get(login.id)!));
    const viewerToken = new URLSearchParams(viewerLink.hash.slice(1)).get("token")!;
    assert.equal((await post("/api/console/exchange", { token: viewerToken }, { origin: config.origin })).status, 401);
    const viewer = await post("/api/viewer/exchange", { requestId: login.id, token: viewerToken }, { origin: config.origin });
    const viewerCookie = viewer.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await fetch(config.origin + "/api/app", { headers: { cookie: viewerCookie } })).status, 401);
  } finally { await coordinator.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
