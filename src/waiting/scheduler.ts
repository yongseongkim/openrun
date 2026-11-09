import { WaitingStore } from "./store.ts";
import type { WaitingJob } from "./store.ts";
import type { SyrupRunner } from "./syrup.ts";
import { kstDate } from "./config.ts";
import { AppError } from "../app/store.ts";

export class WaitingScheduler {
  #store: WaitingStore; #runner: SyrupRunner; #now: () => number;
  #timer?: NodeJS.Timeout; #running?: Promise<void>; #abort = new AbortController();
  #notify?: (job: WaitingJob) => Promise<void>;
  constructor(store: WaitingStore, runner: SyrupRunner, options: { now?: () => number; notify?: (job: WaitingJob) => Promise<void> } = {}) {
    this.#store = store; this.#runner = runner; this.#now = options.now ?? Date.now; this.#notify = options.notify;
  }
  start() { this.#store.recover(); this.#timer = setInterval(() => { void this.tick(); }, 1000); void this.tick(); }
  tick(): Promise<void> {
    if (this.#running) return this.#running;
    if (this.#abort.signal.aborted) return Promise.resolve();
    this.#running = this.#tick().catch(() => {}).finally(() => { this.#running = undefined; });
    return this.#running;
  }
  async #tick() {
    const jobs = this.#store.pending();
    for (const job of jobs) {
      if (job.deadline <= this.#now()) { await this.#end(this.#store.transition(job.id, ["SCHEDULED"], "EXPIRED", { message: "실행 가능 시간이 지났습니다. 자동 등록하지 않았습니다." })); continue; }
      if (this.#now() < job.opensAt - 120000) return;
      try { await this.#runner.prepare(); }
      catch { await this.#end(this.#store.transition(job.id, ["SCHEDULED"], "FAILED", { message: "시럽 브라우저를 준비하지 못했습니다." })); continue; }
      if (this.#abort.signal.aborted || this.#now() < job.opensAt) return;
      if (this.#store.job(job.id).state !== "SCHEDULED") continue;
      if (this.#now() >= job.deadline) { await this.#end(this.#store.transition(job.id, ["SCHEDULED"], "EXPIRED")); continue; }
      this.#store.transition(job.id, ["SCHEDULED"], "RUNNING");
      // A per-job signal prevents an expired job from stopping future days.
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), Math.max(1, job.deadline - this.#now()));
      const stop = () => controller.abort(); this.#abort.signal.addEventListener("abort", stop, { once: true });
      try {
        const result = await this.#runner.run({ partySize: job.partySize, phoneNumber: this.#store.phone(job.id) }, {
          signal: controller.signal,
          beforeSubmit: () => {
            const now = this.#now();
            if (controller.signal.aborted || now < job.opensAt || now >= job.deadline || kstDate(now) !== job.visitDate) throw new AppError("WAITING_DEADLINE_PASSED", 409);
            this.#store.transition(job.id, ["RUNNING"], "SUBMITTING");
          },
        });
        await this.#end(this.#store.transition(job.id, ["SUBMITTING"], "SUCCEEDED", { result, message: "시럽 완료 화면에서 웨이팅 번호를 확인했습니다." }));
      } catch {
        const current = this.#store.job(job.id);
        await this.#end(this.#store.transition(job.id, [current.state], current.state === "SUBMITTING" ? "UNKNOWN" : this.#abort.signal.aborted ? "INTERRUPTED" : "FAILED", { message: current.state === "SUBMITTING" ? "제출 후 결과를 확인하지 못했습니다. 중복 등록을 막기 위해 자동 재시도하지 않습니다. 시럽 내역을 확인해 주세요." : "웨이팅을 완료하지 못했습니다. 시럽 운영 상태와 신청 내역을 확인해 주세요." }));
      } finally { clearTimeout(deadline); this.#abort.signal.removeEventListener("abort", stop); }
      return;
    }
  }
  async #end(job: WaitingJob) {
    if (!job.notify) return;
    try { if (!this.#notify) throw new Error(); await this.#notify(job); this.#store.notification(job.id, "SENT"); }
    catch { this.#store.notification(job.id, "FAILED"); }
  }
  async close() { clearInterval(this.#timer); this.#abort.abort(); await this.#running; await this.#runner.close(); }
}
