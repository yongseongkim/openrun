import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { ROOT } from "../config.ts";
import type { RemoteConfig } from "./config.ts";
import { GrantStore, VIEWER_COOKIE, secretEquals } from "./grants.ts";
import type { AuthCoordinator, LoginRequest } from "./coordinator.ts";
import { AuthError } from "../errors.ts";
import { AppError } from "../app/store.ts";
import type { AppStore } from "../app/store.ts";
import type { WaitingStore } from "../waiting/store.ts";

const OWNER_COOKIE = "openrun_owner";

const REQUEST_ID = /^[a-f0-9-]{36}$/;
class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

function cookie(request: IncomingMessage, name = VIEWER_COOKIE): string | undefined {
  return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "JSON_REQUIRED");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw new HttpError(413, "BODY_TOO_LARGE");
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, "INVALID_JSON"); }
}

function json(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value));
}

export function loginLink(origin: string, grants: GrantStore, request: LoginRequest): string {
  const token = grants.mint(request.id, request.expiresAt);
  return `${origin}/login/${request.id}#token=${token}`;
}

export function createRemoteServer(options: {
  config: RemoteConfig; adminToken: string; coordinator: AuthCoordinator; grants: GrantStore;
  store?: AppStore;
  waitingStore?: WaitingStore;
}) {
  const { config, coordinator, grants } = options;
  // Viewer credentials can never be exchanged for owner access.
  const owners = new GrantStore();
  const sockets = new Map<WebSocket, { requestId: string; sessionCookie: string }>();
  const failures = new Map<string, { count: number; expires: number }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

  function origin(request: IncomingMessage, required = true) {
    if ((required || request.headers.origin) && request.headers.origin !== config.origin) throw new HttpError(403, "ORIGIN_REJECTED");
  }
  function administrator(request: IncomingMessage) {
    origin(request, false);
    const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!secretEquals(supplied, options.adminToken)) throw new HttpError(401, "UNAUTHORIZED");
  }
  function viewer(request: IncomingMessage) {
    origin(request, false);
    const session = grants.authenticate(cookie(request));
    if (!session || !coordinator.get(session.requestId)) throw new HttpError(401, "VIEWER_SESSION_EXPIRED");
    return session;
  }
  function owner(request: IncomingMessage, write = false) {
    if (request.headers.authorization) return administrator(request);
    if (!owners.authenticate(cookie(request, OWNER_COOKIE))) throw new HttpError(401, "OWNER_SESSION_REQUIRED");
    origin(request, write);
  }
  function setCookie(response: ServerResponse, name: string, value: string, expiresAt: number) {
    const secure = config.origin.startsWith("https:") ? "; Secure" : "";
    response.setHeader("set-cookie", `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))}${secure}`);
  }

  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "SAMEORIGIN");
    const websocketOrigin = config.origin.replace(/^http/, "ws");
    response.setHeader("content-security-policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${websocketOrigin}; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'`);
    try {
      const url = new URL(request.url ?? "/", config.origin);
      if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { status: "ok" });
      if (request.method === "POST" && url.pathname === "/api/console/link") {
        administrator(request);
        const token = owners.mint("owner", Date.now() + 600_000);
        return json(response, 200, { url: `${config.origin}/#token=${token}` });
      }
      if (request.method === "POST" && url.pathname === "/api/console/exchange") {
        origin(request);
        const body = await jsonBody(request);
        if (typeof body.token !== "string" || body.token.length > 128) throw new HttpError(400, "INVALID_LINK");
        const session = owners.exchange("owner", body.token, Date.now() + 12 * 3600000);
        if (!session) throw new HttpError(401, "LINK_EXPIRED_OR_USED");
        setCookie(response, OWNER_COOKIE, session.cookie, session.expiresAt);
        return json(response, 200, { expiresAt: session.expiresAt });
      }
      if (url.pathname.startsWith("/api/app")) {
        owner(request, request.method !== "GET");
        const store = options.store;
        if (!store) throw new HttpError(503, "APP_UNAVAILABLE");
        if (url.pathname === "/api/app/waiting" || url.pathname.startsWith("/api/app/waiting/")) {
          const waiting = options.waitingStore;
          if (!waiting) throw new HttpError(503, "WAITING_UNAVAILABLE");
          if (request.method === "GET" && url.pathname === "/api/app/waiting") return json(response, 200, { ...waiting.catalog(), jobs: waiting.jobs(), timezone: "Asia/Seoul" });
          if (request.method === "POST" && url.pathname === "/api/app/waiting") return json(response, 201, { job: waiting.schedule(await jsonBody(request)) });
          const cancel = url.pathname.match(/^\/api\/app\/waiting\/([a-f0-9-]{36})\/cancel$/);
          if (request.method === "POST" && cancel) { await jsonBody(request); return json(response, 200, { job: waiting.cancel(cancel[1]) }); }
          throw new HttpError(404, "NOT_FOUND");
        }
        if (request.method === "GET" && url.pathname === "/api/app") return json(response, 200, { restaurants: store.restaurants(), jobs: store.jobs(), serverTime: Date.now(), timezone: "Asia/Seoul", bookingMode: "ASSISTED" });
        if (request.method === "POST" && url.pathname === "/api/app/restaurants") return json(response, 201, { restaurant: store.saveRestaurant(await jsonBody(request)) });
        const restaurantMatch = url.pathname.match(/^\/api\/app\/restaurants\/([a-zA-Z0-9_-]+)$/);
        if (request.method === "PATCH" && restaurantMatch) return json(response, 200, { restaurant: store.saveRestaurant(await jsonBody(request), restaurantMatch[1]) });
        if (request.method === "POST" && url.pathname === "/api/app/jobs") return json(response, 201, { job: store.draft(await jsonBody(request)) });
        const action = url.pathname.match(/^\/api\/app\/jobs\/([a-f0-9-]{36})\/(arm|cancel|link|finish)$/);
        if (request.method === "POST" && action) {
          const body = await jsonBody(request);
          const job = store.job(action[1]);
          if (action[2] === "arm") {
            if (body.confirmed !== true) throw new HttpError(400, "CONFIRMATION_REQUIRED");
            return json(response, 200, { job: store.arm(job.id) });
          }
          if (action[2] === "cancel") return json(response, 200, { job: store.cancel(job.id) });
          if (!job.requestId) throw new HttpError(409, "BOOKING_SCREEN_NOT_READY");
          const session = coordinator.get(job.requestId);
          if (!session || !coordinator.canControl(session.id)) throw new HttpError(409, "BOOKING_SCREEN_NOT_READY");
          if (action[2] === "link") return json(response, 200, { url: loginLink(config.origin, grants, session) });
          if (job.state !== "READY" || body.confirmed !== true) throw new HttpError(409, "BOOKING_SCREEN_NOT_READY");
          coordinator.finishReservation(session.id);
          return json(response, 202, { status: "COMPLETED_BY_OWNER" });
        }
        throw new HttpError(404, "NOT_FOUND");
      }
      if (request.method === "POST" && url.pathname === "/api/auth/ensure") {
        owner(request, true);
        const body = await jsonBody(request);
        if (body.notify !== undefined && typeof body.notify !== "boolean") throw new HttpError(400, "INVALID_NOTIFY");
        let job;
        try { job = coordinator.ensure(body.notify === true); }
        catch (error) { if (error instanceof AuthError && error.code === "BROWSER_BUSY") throw new HttpError(409, "BROWSER_BUSY"); throw error; }
        return json(response, 202, { request: job, loginUrl: loginLink(config.origin, grants, job) });
      }
      const adminRequest = url.pathname.match(/^\/api\/auth\/requests\/([a-f0-9-]{36})$/);
      if (request.method === "GET" && adminRequest) {
        owner(request);
        const job = coordinator.get(adminRequest[1]);
        if (!job) throw new HttpError(404, "REQUEST_NOT_FOUND");
        return json(response, 200, { request: job });
      }
      if (request.method === "POST" && url.pathname === "/api/viewer/exchange") {
        origin(request);
        const address = request.socket.remoteAddress ?? "unknown";
        const failed = failures.get(address);
        if (failed && failed.expires > Date.now() && failed.count >= 20) throw new HttpError(429, "TRY_LATER");
        const body = await jsonBody(request);
        if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId) || typeof body.token !== "string" || body.token.length > 128) throw new HttpError(400, "INVALID_LINK");
        const job = coordinator.get(body.requestId);
        const session = job && job.state !== "EXPIRED" ? grants.exchange(job.id, body.token) : undefined;
        if (!session) {
          failures.set(address, { count: (failed && failed.expires > Date.now() ? failed.count : 0) + 1, expires: Date.now() + 60_000 });
          if (failures.size > 1000) for (const [key, value] of failures) if (value.expires < Date.now()) failures.delete(key);
          throw new HttpError(401, "LINK_EXPIRED_OR_USED");
        }
        setCookie(response, VIEWER_COOKIE, session.cookie, session.expiresAt);
        return json(response, 200, { expiresAt: session.expiresAt });
      }
      if (request.method === "GET" && url.pathname === "/api/viewer/status") {
        const session = viewer(request);
        const job = coordinator.get(session.requestId)!;
        const booking = job.bookingId && options.store ? options.store.job(job.bookingId) : undefined;
        return json(response, 200, { request: job, ...(booking ? { booking: { ...booking, restaurantName: options.store!.restaurant(booking.restaurantId).name } } : {}) });
      }
      if (request.method === "POST" && url.pathname === "/api/viewer/finish") {
        origin(request); const session = viewer(request); const body = await jsonBody(request);
        if (body.confirmed !== true) throw new HttpError(400, "CONFIRMATION_REQUIRED");
        coordinator.finishReservation(session.requestId);
        return json(response, 200, { status: "COMPLETED_BY_OWNER" });
      }

      if (request.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      let filename: string | undefined;
      if (url.pathname === "/") filename = resolve(ROOT, "public/index.html");
      else if (url.pathname === "/waiting") filename = resolve(ROOT, "public/waiting.html");
      else if (/^\/login\/[a-f0-9-]{36}$/.test(url.pathname)) filename = resolve(ROOT, "public/viewer.html");
      else if (["/assets/viewer.js", "/assets/style.css", "/assets/app.js", "/assets/app.css", "/assets/waiting.js", "/assets/waiting.css"].includes(url.pathname)) filename = resolve(ROOT, "public", url.pathname.slice("/assets/".length));
      else if (url.pathname.startsWith("/vendor/novnc/")) {
        const relative = decodeURIComponent(url.pathname.slice("/vendor/novnc/".length));
        if (!/^(core|vendor)\/[a-zA-Z0-9_./-]+\.(js|wasm)$/.test(relative) || relative.split("/").includes("..")) throw new HttpError(404, "NOT_FOUND");
        filename = resolve(ROOT, "node_modules/@novnc/novnc", relative);
      }
      if (!filename) throw new HttpError(404, "NOT_FOUND");
      const content = await readFile(filename).catch(() => { throw new HttpError(404, "NOT_FOUND"); });
      const type = ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" } as Record<string, string>)[extname(filename)] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": type }); response.end(content);
    } catch (error) {
      const known = error instanceof HttpError || error instanceof AppError;
      if (!response.headersSent) json(response, known ? error.status : error instanceof AuthError && error.code === "BROWSER_BUSY" ? 409 : 500, { error: error instanceof HttpError ? error.code : error instanceof AppError ? error.message : error instanceof AuthError ? error.code : "SERVER_ERROR" });
      else response.end();
    }
  });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", config.origin);
      if (url.pathname !== "/desktop/socket" || url.search) throw new HttpError(404, "NOT_FOUND");
      origin(request);
      const session = viewer(request);
      if (!coordinator.canControl(session.requestId)) throw new HttpError(403, "CONTROL_CLOSED");
      // One controller at a time. Browser switching explicitly replaces the old connection.
      for (const [old, value] of sockets) if (value.requestId === session.requestId) old.close(1000, "Another connection opened");
      wss.handleUpgrade(request, socket, head, (ws) => {
        const sessionCookie = cookie(request)!;
        sockets.set(ws, { requestId: session.requestId, sessionCookie });
        const target = connect({ host: config.vncHost, port: config.vncPort });
        const timer = setInterval(() => {
          if (!grants.authenticate(sessionCookie) || !coordinator.canControl(session.requestId)) ws.close(1000, "Remote access ended");
        }, 1000);
        target.on("data", (data) => {
          target.pause();
          if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true }, () => target.resume());
          else target.destroy();
        });
        ws.on("message", (data, binary) => {
          if (!binary) { ws.close(1003, "Binary frames required"); return; }
          if (!coordinator.canControl(session.requestId) || !grants.authenticate(sessionCookie)) { ws.close(1000); return; }
          const payload = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
          if (!target.write(payload)) { ws.pause(); target.once("drain", () => ws.resume()); }
        });
        const cleanup = () => { clearInterval(timer); sockets.delete(ws); target.destroy(); };
        target.on("error", () => ws.close(1011, "Display unavailable"));
        target.on("close", () => { if (ws.readyState === WebSocket.OPEN) ws.close(1000); });
        ws.on("error", cleanup); ws.on("close", cleanup);
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    }
  });
  const changed = (job: LoginRequest) => {
    if (!coordinator.canControl(job.id)) for (const [ws, session] of sockets) if (session.requestId === job.id) ws.close(1000, "Remote access ended");
  };
  coordinator.on("change", changed);
  server.once("close", () => { coordinator.off("change", changed); for (const ws of sockets.keys()) ws.terminate(); wss.close(); });
  return server;
}
