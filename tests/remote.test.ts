import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as tcpServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { GrantStore, secretEquals } from "../src/remote/grants.ts";
import { publicOrigin, remoteConfig } from "../src/remote/config.ts";
import { AuthCoordinator } from "../src/remote/coordinator.ts";
import type { AuthWorker } from "../src/remote/worker.ts";
import { createRemoteServer } from "../src/remote/server.ts";
import { sendLoginNotification } from "../src/remote/slack.ts";

const adminToken = "fixture-administrator-token-with-enough-entropy";

class FakeWorker implements AuthWorker {
  authenticated = false;
  loginCalls = 0;
  complete?: () => void;
  async check() { return this.authenticated; }
  async login(onApproval: () => void, signal: AbortSignal) {
    this.loginCalls += 1;
    onApproval();
    await new Promise<void>((resolve) => {
      this.complete = () => { this.authenticated = true; resolve(); };
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async close() { this.complete?.(); }
}

async function until(condition: () => boolean) {
  const end = Date.now() + 2000;
  while (!condition()) { if (Date.now() > end) throw new Error("Fixture did not settle"); await delay(5); }
}

test("viewer links are scoped, single use, expire, and replace the previous device", () => {
  let now = 100;
  const grants = new GrantStore(() => now);
  const token = grants.mint("request-one", 200);
  assert.equal(grants.exchange("another-request", token), undefined);
  const first = grants.exchange("request-one", token)!;
  assert.equal(grants.authenticate(first.cookie)?.requestId, "request-one");
  assert.equal(grants.exchange("request-one", token), undefined);
  const second = grants.exchange("request-one", grants.mint("request-one", 200))!;
  assert.equal(grants.authenticate(first.cookie), undefined);
  now = 201;
  assert.equal(grants.authenticate(second.cookie), undefined);
  assert.equal(grants.exchange("request-one", grants.mint("request-one", 200)), undefined);
  assert.equal(secretEquals(adminToken, adminToken), true);
  assert.equal(secretEquals("", adminToken), false);
});

test("remote access uses HTTPS except for local development", () => {
  assert.equal(publicOrigin("http://localhost:4340"), "http://localhost:4340");
  assert.equal(publicOrigin("https://openrun.example.com"), "https://openrun.example.com");
  for (const url of ["http://openrun.example.com", "https://password@example.com", "https://example.com/?token=secret", "https://example.com/path"]) {
    assert.throws(() => publicOrigin(url));
  }
});

test("valid sessions need no login or Slack notification", async () => {
  const worker = new FakeWorker(); worker.authenticated = true;
  let notifications = 0;
  const coordinator = new AuthCoordinator(worker, 10_000, async () => { notifications += 1; });
  const request = coordinator.ensure(true);
  assert.equal((await coordinator.wait(request.id)).state, "AUTHENTICATED");
  assert.equal(worker.loginCalls, 0); assert.equal(notifications, 0);
  await coordinator.close();
});

test("concurrent requests reuse one login; notification failure does not resubmit credentials", async () => {
  const worker = new FakeWorker();
  const coordinator = new AuthCoordinator(worker, 10_000, async () => { throw new Error("mock Slack unavailable"); });
  const first = coordinator.ensure(true);
  assert.equal(coordinator.ensure(true).id, first.id);
  await until(() => coordinator.get(first.id)?.notification === "FAILED");
  assert.equal(coordinator.canControl(first.id), true);
  worker.complete!();
  const result = await coordinator.wait(first.id);
  assert.equal(result.state, "AUTHENTICATED"); assert.equal(result.notification, "FAILED");
  assert.equal(worker.loginCalls, 1); assert.equal(coordinator.canControl(first.id), false);
  await coordinator.close();
});

test("expiration stops remote control and aborts the pending login", async () => {
  const coordinator = new AuthCoordinator(new FakeWorker(), 30);
  const request = coordinator.ensure();
  assert.equal((await coordinator.wait(request.id)).state, "EXPIRED");
  assert.equal(coordinator.canControl(request.id), false);
  await coordinator.close();
});

test("Slack notification contains an expiring link and disables previews", async (t) => {
  let captured: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string);
    return new Response("ok");
  });
  await sendLoginNotification("https://hooks.slack.com/services/fixture", "https://openrun.example/login/one#token=fixture", Date.now() + 60_000);
  assert.equal(captured?.unfurl_links, false); assert.equal(captured?.unfurl_media, false);
  assert.match(JSON.stringify(captured), /로그인 화면 열기/);
  await assert.rejects(() => sendLoginNotification("https://attacker.example/webhook", "https://openrun.example", Date.now()));
});

test("gateway protects links and bridges authenticated VNC traffic until handoff", { timeout: 15_000 }, async () => {
  let received = "";
  const vnc = tcpServer((socket) => { socket.write("RFB 003.008\n"); socket.on("data", (data) => { received += data.toString(); }); });
  vnc.listen(0, "127.0.0.1"); await once(vnc, "listening");
  const config = remoteConfig({ OPENRUN_PUBLIC_URL: "http://127.0.0.1:4340" });
  config.vncPort = (vnc.address() as { port: number }).port;
  const worker = new FakeWorker();
  const coordinator = new AuthCoordinator(worker, 10_000);
  const grants = new GrantStore();
  const server = createRemoteServer({ config, adminToken, coordinator, grants });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  config.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: object, headers: Record<string, string> = {}) => fetch(config.origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let socket: WebSocket | undefined;
  try {
    assert.equal((await post("/api/auth/ensure", {})).status, 401);
    assert.equal((await post("/api/auth/ensure", {}, { authorization: `Bearer ${adminToken}`, origin: "https://attacker.example" })).status, 403);
    const created = await post("/api/auth/ensure", {}, { authorization: `Bearer ${adminToken}` });
    assert.equal(created.status, 202);
    const { request, loginUrl } = await created.json() as { request: { id: string }; loginUrl: string };
    await until(() => coordinator.canControl(request.id));
    const url = new URL(loginUrl);
    const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
    // GET/unfurling the page must not redeem the token.
    assert.equal((await fetch(config.origin + url.pathname)).status, 200);
    assert.equal((await fetch(config.origin + url.pathname)).status, 200);
    assert.equal((await fetch(config.origin + "/api/viewer/status")).status, 401);
    assert.equal((await post("/api/viewer/exchange", { requestId: request.id, token }, { origin: "https://attacker.example" })).status, 403);
    const exchanged = await post("/api/viewer/exchange", { requestId: request.id, token }, { origin: config.origin });
    assert.equal(exchanged.status, 200);
    const setCookie = exchanged.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    const sessionCookie = setCookie.split(";")[0];
    assert.equal((await post("/api/viewer/exchange", { requestId: request.id, token }, { origin: config.origin })).status, 401);
    const info = await fetch(config.origin + "/api/viewer/status", { headers: { cookie: sessionCookie } });
    assert.equal((await info.json() as { request: { state: string } }).request.state, "AUTH_REQUIRED");

    const denied = new WebSocket(config.origin.replace(/^http/, "ws") + "/desktop/socket", { headers: { Origin: config.origin } });
    const unauthorized = await new Promise<number>((resolve) => { denied.on("unexpected-response", (_req, response) => { response.resume(); denied.terminate(); resolve(response.statusCode!); }); denied.on("error", () => {}); });
    assert.equal(unauthorized, 401);

    socket = new WebSocket(config.origin.replace(/^http/, "ws") + "/desktop/socket", { headers: { Origin: config.origin, Cookie: sessionCookie } });
    const firstFrame = once(socket, "message");
    await once(socket, "open");
    assert.equal((await firstFrame)[0].toString(), "RFB 003.008\n");
    socket.send(Buffer.from("fixture-input"));
    await until(() => received === "fixture-input");
    const closed = once(socket, "close");
    worker.complete!();
    assert.equal((await coordinator.wait(request.id)).state, "AUTHENTICATED");
    await closed;
    assert.equal(coordinator.canControl(request.id), false);
    const completed = await fetch(config.origin + "/api/viewer/status", { headers: { cookie: sessionCookie } });
    assert.equal((await completed.json() as { request: { state: string } }).request.state, "AUTHENTICATED");
    const lateToken = grants.mint(request.id, Date.now() + 60_000);
    const late = await post("/api/viewer/exchange", { requestId: request.id, token: lateToken }, { origin: config.origin });
    assert.equal(late.status, 200); // A late Slack click sees completion, without reopening control.
    const lateCookie = late.headers.get("set-cookie")!.split(";")[0];
    const forbidden = new WebSocket(config.origin.replace(/^http/, "ws") + "/desktop/socket", { headers: { Origin: config.origin, Cookie: lateCookie } });
    const closedControl = await new Promise<number>((resolve) => { forbidden.on("unexpected-response", (_req, response) => { response.resume(); forbidden.terminate(); resolve(response.statusCode!); }); forbidden.on("error", () => {}); });
    assert.equal(closedControl, 403);
  } finally {
    socket?.terminate(); await coordinator.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => vnc.close(() => resolve()));
  }
});
