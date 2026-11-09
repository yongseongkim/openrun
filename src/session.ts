import type { BrowserContext, Page } from "playwright";
import type { Provider } from "./config.ts";
import { APP_ORIGIN } from "./config.ts";
import type { SessionStorage, StorageState } from "./browser.ts";
import { decryptJson, encryptJson, exists } from "./sops.ts";
import { AuthError } from "./errors.ts";

export type SavedSession = {
  version: 1;
  provider: Provider;
  accountId: string;
  savedAt: string;
  storageState: StorageState;
  sessionStorage: SessionStorage;
};

export function validateSession(value: unknown, provider: Provider): SavedSession {
  const session = value as Partial<SavedSession> | null;
  if (!session || session.version !== 1 || session.provider !== provider || typeof session.accountId !== "string" || !session.accountId ||
    typeof session.savedAt !== "string" || !Number.isFinite(Date.parse(session.savedAt)) ||
    !Array.isArray(session.storageState?.cookies) || !Array.isArray(session.storageState?.origins) ||
    !session.sessionStorage || typeof session.sessionStorage !== "object" || Array.isArray(session.sessionStorage)) {
    throw new AuthError("INVALID_SESSION", "저장된 세션 형식이 올바르지 않습니다. 해당 .auth 세션 파일을 옮긴 뒤 다시 로그인해 주세요.");
  }
  return session as SavedSession;
}

export async function loadSession(filename: string, provider: Provider): Promise<SavedSession | undefined> {
  if (!await exists(filename)) return undefined;
  return validateSession(await decryptJson(filename), provider);
}

export async function captureSession(context: BrowserContext, page: Page, provider: Provider, accountId: string): Promise<SavedSession> {
  if (new URL(page.url()).origin !== APP_ORIGIN) throw new AuthError("INVALID_SESSION", "캐치테이블 페이지에서만 세션을 저장할 수 있습니다.");
  const entries = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  return {
    version: 1, provider, accountId, savedAt: new Date().toISOString(),
    storageState: await context.storageState({ indexedDB: true }),
    sessionStorage: { [APP_ORIGIN]: entries },
  };
}

export async function saveSession(filename: string, session: SavedSession): Promise<void> {
  await encryptJson(filename, session);
}
