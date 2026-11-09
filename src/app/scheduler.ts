import type { Page } from "playwright";
import { AppStore, AppError } from "./store.ts";
import type { BookingJob, Restaurant } from "./store.ts";
import type { AuthCoordinator, LoginRequest } from "../remote/coordinator.ts";
import { AuthError } from "../errors.ts";

// No final-submit selector is used here. These restaurants require individual
// menu, card/no-show and cancellation decisions; the owner completes them in
// the same authenticated remote browser. READY never means BOOKED.
export async function prepareRestaurant(page: Page, restaurant: Restaurant, job: BookingJob) {
  const url = new URL(restaurant.url);
  url.searchParams.set("date", job.diningDate.slice(2).replaceAll("-", ""));
  await page.goto(url.href, { waitUntil: "commit", timeout: 45_000 });
  await page.getByText("예약하기", { exact: true }).first().waitFor({ timeout: 35_000 });
  if (new URL(page.url()).origin !== "https://app.catchtable.co.kr") throw new AppError("UNEXPECTED_BOOKING_PAGE");
  await page.bringToFront();
}

export class BookingScheduler {
  #store: AppStore; #coordinator: AuthCoordinator;
  #now: () => number; #timer?: NodeJS.Timeout;
  #running?: Promise<void>; #abort = new AbortController();
  #notification?: Promise<void>;
  #auth = new Map<string, string>();
  #prepare: typeof prepareRestaurant;
  #ready?: (job: BookingJob, request: LoginRequest) => Promise<void>;
  constructor(store: AppStore, coordinator: AuthCoordinator, options: {
    now?: () => number; prepare?: typeof prepareRestaurant;
    ready?: (job: BookingJob, request: LoginRequest) => Promise<void>;
  } = {}) {
    this.#store = store; this.#coordinator = coordinator; this.#now = options.now ?? Date.now;
    this.#prepare = options.prepare ?? prepareRestaurant; this.#ready = options.ready;
  }
  start() {
    this.#store.recover();
    this.#timer = setInterval(() => { void this.tick(); }, 1000);
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.#running) return this.#running;
    if (this.#abort.signal.aborted) return Promise.resolve();
    this.#running = this.#tick().catch(() => {
      // Keep the daemon alive; individual jobs record a safe outcome below.
    }).finally(() => { this.#running = undefined; });
    return this.#running;
  }
  async #tick() {
    const now = this.#now();
    for (const job of this.#store.jobs().sort((a, b) => a.opensAt - b.opensAt)) {
      if (!["SCHEDULED", "NEEDS_LOGIN"].includes(job.state)) continue;
      if (job.deadline <= now) { this.#store.transition(job.id, [job.state], "EXPIRED", { message: "예약 실행 시간이 지났습니다." }); continue; }
      // Check login ten minutes before opening; navigation itself starts at opensAt.
      if (now < job.opensAt - 600_000) continue;
      let authId = this.#auth.get(job.id);
      if (!authId) {
        try { authId = this.#coordinator.ensure(job.notify).id; this.#auth.set(job.id, authId); }
        catch (error) { if (error instanceof AuthError && error.code === "BROWSER_BUSY") return; throw error; }
        return;
      }
      const auth = this.#coordinator.get(authId);
      if (!auth || ["EXPIRED", "FAILED"].includes(auth.state)) {
        this.#store.transition(job.id, [job.state], "FAILED", { message: "로그인 확인을 완료하지 못했습니다. 계정 연결 후 새 요청을 등록해 주세요." }); continue;
      }
      if (auth.state === "AUTH_REQUIRED" && job.state !== "NEEDS_LOGIN") this.#store.transition(job.id, [job.state], "NEEDS_LOGIN", { requestId: authId, message: "로그인 확인이 필요합니다. 계정 연결을 열어 주세요." });
      if (auth.state !== "AUTHENTICATED" || now < job.opensAt) return;
      const claimed = this.#store.claim(job.id);
      try {
        const result = await this.#coordinator.reservation(job.id, job.deadline, page => this.#prepare(page, this.#store.restaurant(job.restaurantId), claimed), request => {
          const ready = this.#store.transition(job.id, ["PREPARING"], "READY", { requestId: request.id, message: "서버의 예약 화면이 준비됐습니다. 날짜·시간·인원, 메뉴 및 취소 규정을 확인하고 직접 예약을 확정해 주세요." });
          // Notification failure must never replay a browser action.
          if (ready.notify) this.#notification = this.#notify(ready, request);
        }, this.#abort.signal);
        this.#store.transition(job.id, ["PREPARING", "READY"], result, { message: result === "COMPLETED" ? "사용자가 예약 내역 확인을 완료했습니다. 실제 확정 여부는 캐치테이블 내역을 기준으로 합니다." : "원격 예약 화면 접속 시간이 끝났습니다. 다시 시도하기 전 캐치테이블 예약 내역을 확인해 주세요." });
      } catch (error) {
        const latest = this.#store.job(job.id);
        this.#store.transition(job.id, [latest.state], latest.state === "READY" ? "INTERRUPTED" : "FAILED", { message: error instanceof AuthError && error.code === "NEEDS_LOGIN" ? "로그인이 만료됐습니다. 계정 연결 후 새 요청을 등록해 주세요." : "예약 화면을 준비하지 못했거나 연결이 끊겼습니다. 캐치테이블에서 매장 및 예약 내역을 확인해 주세요." });
      }
      return;
    }
  }
  async #notify(job: BookingJob, request: LoginRequest) {
    try {
      if (!this.#ready) throw new Error("Notification unavailable");
      await this.#ready(job, request); this.#store.notification(job.id, "SENT");
    } catch { this.#store.notification(job.id, "FAILED"); }
  }
  async close() { clearInterval(this.#timer); this.#abort.abort(); await this.#running; await this.#notification; }
}
