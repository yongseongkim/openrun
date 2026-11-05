import { resolve } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { ROOT } from "./config.ts";
import { AuthError } from "./errors.ts";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
export type SessionStorage = Record<string, Record<string, string>>;

export async function playwright() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(ROOT, ".cache/ms-playwright");
  return import("playwright");
}

export async function launchBrowser(options: { headless: boolean; channel?: string }): Promise<Browser> {
  const { chromium } = await playwright();
  try { return await chromium.launch({ headless: options.headless, channel: options.channel }); }
  catch { throw new AuthError("BROWSER_UNAVAILABLE", "브라우저를 시작하지 못했습니다. Google Chrome 설치와 실행 권한을 확인해 주세요."); }
}

export async function newAuthContext(browser: Browser, session?: { storageState: StorageState; sessionStorage: SessionStorage }): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: "ko-KR", timezoneId: "Asia/Seoul", storageState: session?.storageState,
  });
  if (session) {
    await context.addInitScript((origins) => {
      for (const [key, value] of Object.entries(origins[location.origin] ?? {})) sessionStorage.setItem(key, value);
    }, session.sessionStorage);
  }
  return context;
}
