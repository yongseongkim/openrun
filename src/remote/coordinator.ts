import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AuthError, publicError } from "../errors.ts";
import type { AuthWorker } from "./worker.ts";
import type { Page } from "playwright";

export type RequestState = "CHECKING" | "AUTH_REQUIRED" | "AUTHENTICATED" | "BOOKING_REQUIRED" | "COMPLETED" | "FAILED" | "EXPIRED";
export type LoginRequest = {
  id: string; state: RequestState; createdAt: number; expiresAt: number;
  notification: "NONE" | "SENT" | "FAILED"; error?: { status: string; message: string };
  purpose?: "RESERVATION"; bookingId?: string;
};

export class AuthCoordinator extends EventEmitter {
  #worker: AuthWorker;
  #ttlMs: number;
  #requests = new Map<string, LoginRequest>();
  #active?: LoginRequest;
  #abort?: AbortController;
  #running?: Promise<void>;
  #notify?: (request: LoginRequest) => Promise<void>;
  #notifyWanted = new Set<string>();
  #notifying = new Set<string>();
  #usingBrowser = false;
  #finish = new Map<string, () => void>();

  constructor(worker: AuthWorker, ttlMs: number, notify?: (request: LoginRequest) => Promise<void>) {
    super(); this.#worker = worker; this.#ttlMs = ttlMs; this.#notify = notify;
  }

  ensure(notify = false): LoginRequest {
    if (this.#usingBrowser) throw new AuthError("BROWSER_BUSY", "브라우저에서 다른 작업을 실행 중입니다. 잠시 후 다시 확인해 주세요.");
    if (this.#active && ["CHECKING", "AUTH_REQUIRED"].includes(this.#active.state)) {
      if (notify) this.#notifyWanted.add(this.#active.id);
      if (this.#active.state === "AUTH_REQUIRED") void this.#sendNotification(this.#active);
      return this.#active;
    }
    // Keep bounded history, without account identifiers or session contents.
    for (const [id, request] of this.#requests) if (request.expiresAt < Date.now()) this.#requests.delete(id);
    if (this.#requests.size >= 100) this.#requests.delete(this.#requests.keys().next().value!);
    const now = Date.now();
    const request: LoginRequest = { id: randomUUID(), state: "CHECKING", createdAt: now, expiresAt: now + this.#ttlMs, notification: "NONE" };
    this.#active = request; this.#requests.set(request.id, request);
    this.#abort = new AbortController();
    if (notify) this.#notifyWanted.add(request.id);
    const previous = this.#running;
    const abort = this.#abort;
    this.#running = (async () => { await previous; if (!abort.signal.aborted) await this.#run(request, abort); })();
    return request;
  }

  async #run(request: LoginRequest, abort: AbortController) {
    const timeout = setTimeout(() => { this.#state(request, "EXPIRED"); abort.abort(); }, Math.max(1, request.expiresAt - Date.now()));
    try {
      if (!await this.#worker.check()) {
        if (abort.signal.aborted) return;
        await this.#worker.login(() => {
          if (abort.signal.aborted || !["CHECKING", "AUTH_REQUIRED"].includes(request.state)) return;
          this.#state(request, "AUTH_REQUIRED");
          void this.#sendNotification(request);
        }, abort.signal);
      }
      if (!abort.signal.aborted) this.#state(request, "AUTHENTICATED");
    } catch (error) {
      if (!abort.signal.aborted) {
        request.error = publicError(error); this.#state(request, "FAILED");
      }
    } finally { clearTimeout(timeout); }
  }

  async #sendNotification(request: LoginRequest) {
    if (!this.#notifyWanted.has(request.id) || this.#notifying.has(request.id) || request.notification === "SENT") return;
    this.#notifying.add(request.id);
    try {
      if (!this.#notify) throw new AuthError("SLACK_NOT_CONFIGURED", "Slack Webhook 설정이 필요합니다.");
      await this.#notify(request); request.notification = "SENT";
    } catch { request.notification = "FAILED"; }
    finally { this.#notifyWanted.delete(request.id); this.#notifying.delete(request.id); this.emit("change", { ...request }); }
  }

  #state(request: LoginRequest, state: RequestState) {
    request.state = state; this.emit("change", { ...request });
  }

  get(id: string): LoginRequest | undefined { const request = this.#requests.get(id); return request ? { ...request } : undefined; }
  canControl(id: string): boolean { const request = this.#requests.get(id); return !!request && ["AUTH_REQUIRED", "BOOKING_REQUIRED"].includes(request.state) && request.expiresAt > Date.now(); }

  async reservation(bookingId: string, expiresAt: number, prepare: (page: Page) => Promise<void>, ready: (request: LoginRequest) => void, signal: AbortSignal): Promise<"COMPLETED" | "EXPIRED"> {
    return this.withAuthenticatedPage(async (page) => {
      if (signal.aborted || Date.now() >= expiresAt) return "EXPIRED";
      await prepare(page);
      if (signal.aborted || Date.now() >= expiresAt) return "EXPIRED";
      const request: LoginRequest = { id: randomUUID(), state: "BOOKING_REQUIRED", purpose: "RESERVATION", bookingId, createdAt: Date.now(), expiresAt, notification: "NONE" };
      this.#requests.set(request.id, request);
      let finish!: () => void;
      const waiting = new Promise<void>(resolve => { finish = resolve; });
      this.#finish.set(request.id, finish);
      const expire = () => { this.#state(request, "EXPIRED"); finish(); };
      const timeout = setTimeout(expire, Math.max(1, expiresAt - Date.now()));
      signal.addEventListener("abort", expire, { once: true });
      try {
        ready({ ...request });
        await waiting;
        return request.state === "COMPLETED" ? "COMPLETED" : "EXPIRED";
      } finally {
        clearTimeout(timeout); signal.removeEventListener("abort", expire); this.#finish.delete(request.id);
        if (request.state === "BOOKING_REQUIRED") this.#state(request, "EXPIRED");
      }
    });
  }

  finishReservation(id: string) {
    const request = this.#requests.get(id);
    if (!request || request.purpose !== "RESERVATION" || !this.canControl(id)) throw new AuthError("REQUEST_NOT_FOUND", "진행 중인 예약 화면을 찾을 수 없습니다.");
    this.#state(request, "COMPLETED"); this.#finish.get(id)?.();
  }

  async wait(id: string): Promise<LoginRequest> {
    if (this.#active?.id === id) await this.#running;
    const request = this.get(id);
    if (!request) throw new AuthError("REQUEST_NOT_FOUND", "로그인 요청을 찾을 수 없습니다.");
    return request;
  }

  async withAuthenticatedPage<T>(action: (page: Page) => Promise<T>): Promise<T> {
    if (this.#usingBrowser || this.#active && ["CHECKING", "AUTH_REQUIRED"].includes(this.#active.state)) {
      throw new AuthError("BROWSER_BUSY", "로그인 또는 다른 브라우저 작업이 끝난 뒤 실행해 주세요.");
    }
    if (!this.#worker.withAuthenticatedPage) throw new AuthError("AUTOMATION_UNAVAILABLE", "이 작업 환경은 브라우저 작업을 지원하지 않습니다.");
    this.#usingBrowser = true;
    try { return await this.#worker.withAuthenticatedPage(action); }
    finally { this.#usingBrowser = false; }
  }

  async close() {
    for (const [id, finish] of this.#finish) { const request = this.#requests.get(id)!; this.#state(request, "EXPIRED"); finish(); }
    this.#abort?.abort();
    if (this.#active && ["CHECKING", "AUTH_REQUIRED"].includes(this.#active.state)) this.#state(this.#active, "EXPIRED");
    await this.#worker.close();
    await this.#running;
  }
}
