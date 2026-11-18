import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Page, Response } from "playwright";
import { APP_ORIGIN, INIT_URL } from "./config.ts";
import type { Provider } from "./config.ts";
import type { Credentials } from "./credentials.ts";
import { AuthError } from "./errors.ts";

export const PROVIDERS = {
  naver: {
    button: "네이버로 시작", origin: "https://nid.naver.com",
    username: 'input[name="id"]', password: 'input[name="pw"]',
    submit: '#loginBtn_column:visible, #loginBtn_row:visible, button[id="log.login"]:visible',
    remember: '#loginStay',
  },
  kakao: {
    button: "카카오로 시작", origin: "https://accounts.kakao.com",
    username: 'input[name="loginId"]', password: 'input[name="password"]',
    submit: 'button[type="submit"]:visible', remember: 'input[name="saveSignedIn"]',
  },
} as const;

export type AuthStatus = { authenticated: false } | { authenticated: true; accountId: string };

export function parseAuthResponse(value: unknown): AuthStatus {
  const result = value as { resultCode?: unknown; data?: { auth?: { isLogin?: unknown; currentUser?: { loggedIn?: unknown; ctUserIdentifier?: unknown } } } } | null;
  const auth = result?.data?.auth;
  if (result?.resultCode !== "CT_OK" || !auth || typeof auth.isLogin !== "boolean") {
    throw new AuthError("AUTH_CHECK_UNAVAILABLE", "캐치테이블 로그인 상태 응답 형식을 확인하지 못했습니다.");
  }
  if (!auth.isLogin) return { authenticated: false };
  const identifier = auth.currentUser?.ctUserIdentifier;
  if (auth.currentUser?.loggedIn === false || typeof identifier !== "string" || !identifier.trim()) {
    throw new AuthError("AUTH_CHECK_UNAVAILABLE", "캐치테이블 계정 식별 정보를 확인하지 못했습니다.");
  }
  return { authenticated: true, accountId: identifier };
}

export function assertAccount(status: AuthStatus, expected?: string): asserts status is Extract<AuthStatus, { authenticated: true }> {
  if (!status.authenticated) throw new AuthError("NEEDS_LOGIN", "캐치테이블 로그인이 필요합니다.");
  if (expected && status.accountId !== expected) {
    throw new AuthError("ACCOUNT_MISMATCH", "저장된 세션과 다른 캐치테이블 계정입니다. 세션을 덮어쓰지 않았습니다.");
  }
}

function isInit(response: Response): boolean {
  return response.url().split("?")[0] === INIT_URL;
}

// Observe the application's own authenticated request, including its current headers.
// A social-provider success page or a URL change alone is not proof of Catchtable login.
export async function checkAuthentication(page: Page, timeoutMs = 60_000): Promise<AuthStatus> {
  const responsePromise = page.waitForResponse(isInit, { timeout: timeoutMs }).catch(() => undefined);
  try { await page.goto(APP_ORIGIN, { waitUntil: "commit", timeout: timeoutMs }); }
  catch { throw new AuthError("AUTH_CHECK_UNAVAILABLE", "캐치테이블 페이지에 연결하지 못했습니다. 네트워크 상태와 브라우저 화면을 확인해 주세요."); }
  const response = await responsePromise;
  if (!response || !response.ok()) throw new AuthError("AUTH_CHECK_UNAVAILABLE", "캐치테이블 로그인 상태를 서버에서 확인하지 못했습니다.");
  try { return parseAuthResponse(await response.json()); }
  catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("AUTH_CHECK_UNAVAILABLE", "캐치테이블 로그인 상태를 읽지 못했습니다.");
  }
}

export async function openProvider(page: Page, provider: Provider): Promise<Page> {
  const definition = PROVIDERS[provider];
  try { await page.goto(`${APP_ORIGIN}/ct/login`, { waitUntil: "commit", timeout: 60_000 }); }
  catch { throw new AuthError("LOGIN_PAGE_UNAVAILABLE", "캐치테이블 로그인 페이지를 불러오지 못했습니다."); }
  const popupPromise = page.waitForEvent("popup", { timeout: 4_000 }).catch(() => null);
  try { await page.getByRole("button", { name: definition.button, exact: true }).click({ timeout: 60_000 }); }
  catch { throw new AuthError("LOGIN_BUTTON_UNAVAILABLE", "캐치테이블의 로그인 버튼을 누르지 못했습니다. 브라우저 화면과 네트워크 상태를 확인해 주세요."); }
  const target = await popupPromise ?? page;
  if (!target.isClosed()) await target.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  return target;
}

export function trustedProviderUrl(url: string, provider: Provider): boolean {
  try { return new URL(url).origin === PROVIDERS[provider].origin; }
  catch { return false; }
}

export async function inspectProviderForm(page: Page, provider: Provider): Promise<void> {
  if (!trustedProviderUrl(page.url(), provider)) {
    throw new AuthError("UNEXPECTED_LOGIN_ORIGIN", "예상한 로그인 제공자의 페이지가 아니므로 계정 정보를 입력하지 않았습니다.");
  }
  const definition = PROVIDERS[provider];
  await page.locator(definition.username).waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(definition.password).waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(definition.submit).first().waitFor({ state: "visible", timeout: 15_000 });
}

export async function submitCredentials(page: Page, provider: Provider, credentials: Credentials): Promise<void> {
  try { await inspectProviderForm(page, provider); }
  catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("LOGIN_FORM_UNAVAILABLE", "로그인 제공자의 계정 입력 화면을 확인하지 못했습니다.");
  }
  const definition = PROVIDERS[provider];
  if (!trustedProviderUrl(page.url(), provider)) throw new AuthError("UNEXPECTED_LOGIN_ORIGIN", "로그인 페이지가 변경되어 입력을 중단했습니다.");
  try { await page.locator(definition.username).fill(credentials.username); }
  catch { throw new AuthError("CREDENTIAL_ENTRY_FAILED", "로그인 아이디를 입력하지 못했습니다."); }
  // Recheck the origin after each asynchronous interaction before entering a password.
  if (!trustedProviderUrl(page.url(), provider)) throw new AuthError("UNEXPECTED_LOGIN_ORIGIN", "로그인 페이지가 변경되어 입력을 중단했습니다.");
  try { await page.locator(definition.password).fill(credentials.password); }
  catch { throw new AuthError("CREDENTIAL_ENTRY_FAILED", "로그인 비밀번호를 입력하지 못했습니다."); }
  const remember = page.locator(definition.remember);
  // Provider checkboxes can be covered by custom labels. This optional preference
  // must not block login when its presentation changes.
  if (await remember.isVisible()) await remember.check({ timeout: 2_000 }).catch(() => {});
  if (!trustedProviderUrl(page.url(), provider)) throw new AuthError("UNEXPECTED_LOGIN_ORIGIN", "로그인 페이지가 변경되어 입력을 중단했습니다.");
  try { await page.locator(definition.submit).first().click(); }
  catch {
    // Some OAuth popups close before Playwright's click navigation wait finishes.
    if (page.isClosed() || new URL(page.url()).origin === APP_ORIGIN) return;
    throw new AuthError("LOGIN_SUBMIT_FAILED", "로그인 버튼 동작을 완료하지 못했습니다. 브라우저에서 로그인 상태를 확인해 주세요.");
  }
}

export function classifyLoginPage(text: string): "approval" | "rejected" | "pending" {
  if (/아이디(?:\([^)]*\))?\s*또는\s*비밀번호|아이디와\s*비밀번호를.*확인|비밀번호가.*(틀|잘못)|incorrect.{0,30}(password|username)|invalid.{0,30}(password|username)|check your (id|password)/i.test(text)) return "rejected";
  if (/captcha|캡차|보안\s*(문자|확인)|자동입력\s*방지|2단계\s*인증|추가\s*인증|인증\s*요청|인증번호|로그인\s*허용|two.step|verification code|security (check|verification)|enter (the )?characters|verify you are human|approve.{0,20}(sign.in|login)/i.test(text)) return "approval";
  return "pending";
}

export async function hasVisibleCaptcha(page: Page): Promise<boolean> {
  // Only detect the challenge; its solution stays in the user's browser.
  return page.locator('input[name*="captcha" i]:visible, input[id*="captcha" i]:visible, img[id*="captcha" i]:visible, iframe[src*="captcha" i]:visible, iframe[title*="captcha" i]:visible, canvas[id*="captcha" i]:visible').count().then((count) => count > 0).catch(() => false);
}

export async function waitForAuthentication(context: BrowserContext, options: {
  provider: Provider; headless: boolean; timeoutMs: number; onApproval?: () => void; signal?: AbortSignal;
}, trigger: () => Promise<void>): Promise<AuthStatus> {
  let authenticated: AuthStatus | undefined;
  const listener = async (response: Response) => {
    if (!isInit(response) || !response.ok()) return;
    try {
      const status = parseAuthResponse(await response.json());
      if (status.authenticated) authenticated = status;
    } catch { /* Only a verified response can mark authentication successful. */ }
  };
  context.on("response", listener);
  const deadline = Date.now() + options.timeoutMs;
  let notified = false;
  try {
    if (options.signal?.aborted) throw new AuthError("AUTH_REQUEST_CANCELLED", "로그인 요청이 종료됐습니다.");
    await trigger();
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new AuthError("AUTH_REQUEST_CANCELLED", "로그인 요청이 종료됐습니다.");
      if (authenticated) return authenticated;
      for (const page of context.pages()) {
        if (!trustedProviderUrl(page.url(), options.provider)) continue;
        const text = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
        const state = await hasVisibleCaptcha(page) ? "approval" : classifyLoginPage(text);
        if (state === "rejected") throw new AuthError("LOGIN_REJECTED", "로그인 제공자가 계정 정보를 거부했습니다. SOPS 파일의 계정 정보를 확인해 주세요.");
        if (state === "approval") {
          if (options.headless) throw new AuthError("NEEDS_AUTH_APPROVAL", "추가 인증이 필요합니다. --headless 없이 다시 실행해 브라우저에서 완료해 주세요.");
          if (!notified) { options.onApproval?.(); notified = true; }
        }
      }
      if (!context.pages().length) throw new AuthError("LOGIN_CANCELLED", "브라우저가 닫혀 로그인을 종료했습니다.");
      await delay(300);
    }
    throw new AuthError("NEEDS_AUTH_APPROVAL", "로그인이 완료되지 않았습니다. 브라우저의 추가 인증·동의 화면을 확인하고 다시 실행해 주세요.");
  } finally { context.off("response", listener); }
}
