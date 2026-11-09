import type { Browser, Page } from "playwright";
import { launchBrowser } from "../browser.ts";
import { AuthError } from "../errors.ts";
import { NANIYORI } from "./config.ts";
import type { WaitingResult } from "./store.ts";

// Core flow migrated from bots-on-lambda/syrupWaitingForNaniyori, commit e28c04b.
// Discovery retries happen only before the input/confirmation flow. A failed
// final click or unreadable result must never fall back to another submission.
function stopped(signal?: AbortSignal) { if (signal?.aborted) throw new AuthError("WAITING_ABORTED", "웨이팅 실행이 중단됐습니다."); }
async function trusted(page: Page) {
  if (new URL(page.url()).origin !== "https://wait.syrupfriends.com") throw new AuthError("WAITING_UNEXPECTED_ORIGIN", "시럽 페이지 주소를 확인하지 못했습니다.");
  if (await page.locator('iframe[src*="captcha"],.g-recaptcha,input[name*="captcha"]').first().isVisible().catch(() => false)) throw new AuthError("WAITING_NEEDS_APPROVAL", "시럽에서 추가 확인이 필요합니다.");
}
export async function registerNaniyori(browser: Browser, input: { partySize: number; phoneNumber: string }, options: {
  beforeSubmit: () => void | Promise<void>; signal?: AbortSignal; discoveryTimeoutMs?: number; resultTimeoutMs?: number;
}): Promise<WaitingResult> {
  if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > NANIYORI.maxPartySize || !/^01[016789]\d{7,8}$/.test(input.phoneNumber)) throw new AuthError("WAITING_INVALID_INPUT", "인원과 연락처를 확인해 주세요.");
  const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const abort = () => { void context.close().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    stopped(options.signal);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const plus = page.locator("button.button-updown").nth(1);
    for (let attempt = 0; attempt < 3; attempt++) {
      stopped(options.signal);
      await page.goto(NANIYORI.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await trusted(page);
      try { await plus.waitFor({ state: "visible", timeout: options.discoveryTimeoutMs ?? 8000 }); break; }
      catch (error) { if (attempt === 2 || options.signal?.aborted) throw error; }
    }
    await trusted(page);
    // Existing Syrup form starts at one guest, with minus/plus in this order.
    for (let i = 1; i < input.partySize; i++) { stopped(options.signal); await plus.click(); }
    await page.locator("#test_input").fill(input.phoneNumber);
    stopped(options.signal); await trusted(page);
    await page.locator(".button-next").click();
    await page.locator(".info-group-step3").waitFor({ state: "visible" });
    stopped(options.signal); await trusted(page);
    await options.beforeSubmit(); // Durable SUBMITTING is committed before click.
    stopped(options.signal);
    await page.locator(".button-next").click();
    const titles = page.locator('[class*="wait_text-title"]');
    await titles.nth(2).waitFor({ state: "visible", timeout: options.resultTimeoutMs ?? 10000 });
    await trusted(page);
    const result = {
      waitNumber: (await titles.nth(0).innerText()).trim(),
      teamsAhead: (await page.locator('[class*="wait_text-point"]').nth(1).innerText()).trim(),
      registrationTime: (await titles.nth(2).innerText()).trim(),
    };
    const numeric = [result.waitNumber, result.teamsAhead].every(value => /^\d{1,6}$/.test(value.replace(/\D/g, "")));
    const time = /(?:[01]?\d|2[0-3]):[0-5]\d/.test(result.registrationTime);
    const contact = /01[016789][ -]?\d{3,4}[ -]?\d{4}/;
    if (!numeric || !time || Object.values(result).some(value => value.length > 100 || contact.test(value))) throw new AuthError("WAITING_RESULT_UNCONFIRMED", "웨이팅 등록 결과를 확인하지 못했습니다.");
    return result;
  } finally { options.signal?.removeEventListener("abort", abort); await context.close().catch(() => {}); }
}
export interface SyrupRunner {
  prepare(): Promise<void>;
  run(input: { partySize: number; phoneNumber: string }, options: { beforeSubmit: () => void | Promise<void>; signal: AbortSignal }): Promise<WaitingResult>;
  close(): Promise<void>;
}
export class SyrupWorker implements SyrupRunner {
  #browser?: Browser; #launch?: Promise<Browser>;
  async prepare() {
    if (this.#browser?.isConnected()) return;
    this.#launch ??= launchBrowser({ headless: true, channel: "chromium" });
    try { this.#browser = await this.#launch; } finally { this.#launch = undefined; }
  }
  async run(input: { partySize: number; phoneNumber: string }, options: { beforeSubmit: () => void | Promise<void>; signal: AbortSignal }) {
    await this.prepare(); return registerNaniyori(this.#browser!, input, options);
  }
  async close() { await this.#launch?.catch(() => {}); await this.#browser?.close(); this.#browser = undefined; }
}
