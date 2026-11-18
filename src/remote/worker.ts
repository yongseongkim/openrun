import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { Provider } from "../config.ts";
import type { RemoteConfig } from "./config.ts";
import type { Credentials } from "../credentials.ts";
import { playwright } from "../browser.ts";
import { AuthError } from "../errors.ts";
import { assertAccount, checkAuthentication, openProvider, submitCredentials, trustedProviderUrl, waitForAuthentication } from "../catchtable.ts";
import { captureSession, loadSession, saveSession } from "../session.ts";
import type { SavedSession } from "../session.ts";

export interface AuthWorker {
  check(): Promise<boolean>;
  login(onApproval: () => void, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  withAuthenticatedPage?<T>(action: (page: Page) => Promise<T>): Promise<T>;
}

export class PersistentAuthWorker implements AuthWorker {
  #context?: BrowserContext;
  #page?: Page;
  #saved?: SavedSession;
  #restored = false;
  #accountId?: string;
  #authenticated = false;
  #config: RemoteConfig;
  #credentials?: Credentials;
  #save: (file: string, session: SavedSession) => Promise<void>;
  #load: (file: string, provider: Provider) => Promise<SavedSession | undefined>;
  #setup?: (context: BrowserContext) => Promise<void>;

  constructor(config: RemoteConfig, credentials?: Credentials, overrides: {
    save?: typeof saveSession; load?: typeof loadSession; setup?: (context: BrowserContext) => Promise<void>;
  } = {}) {
    this.#config = config; this.#credentials = credentials;
    this.#save = overrides.save ?? saveSession; this.#load = overrides.load ?? loadSession; this.#setup = overrides.setup;
  }

  async #browser(): Promise<{ context: BrowserContext; page: Page }> {
    if (this.#context) {
      if (!this.#page || this.#page.isClosed()) this.#page = await this.#context.newPage();
      return { context: this.#context, page: this.#page };
    }
    const profile = resolve(this.#config.profileDir, this.#config.provider);
    await mkdir(resolve(profile, "Default"), { recursive: true, mode: 0o700 });
    const preferencesPath = resolve(profile, "Default/Preferences");
    const preferences = JSON.parse(await readFile(preferencesPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    }));
    // This dedicated automation profile keeps credentials in SOPS; Chrome's
    // optional password-save bubble otherwise covers the human approval form.
    preferences.credentials_enable_service = false;
    preferences.profile = { ...preferences.profile, password_manager_enabled: false };
    await writeFile(preferencesPath, JSON.stringify(preferences), { mode: 0o600 });
    this.#saved = await this.#load(this.#sessionFile(), this.#config.provider);
    this.#restored = false; this.#authenticated = false;
    const { chromium } = await playwright();
    this.#context = await chromium.launchPersistentContext(profile, {
      headless: false, channel: this.#config.channel, locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: null,
      args: ["--window-size=1280,900", "--disable-dev-shm-usage"],
    });
    const activeContext = this.#context;
    activeContext.once("close", () => {
      if (this.#context === activeContext) { this.#context = undefined; this.#page = undefined; this.#authenticated = false; }
    });
    await this.#setup?.(this.#context);
    if (this.#saved) {
      await this.#context.addInitScript((origins) => {
        for (const [key, value] of Object.entries(origins[location.origin] ?? {})) {
          if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
        }
      }, this.#saved.sessionStorage);
    }
    this.#page = this.#context.pages()[0] ?? await this.#context.newPage();
    return { context: this.#context, page: this.#page };
  }

  #sessionFile() { return resolve(this.#config.authDir, `catchtable.${this.#config.provider}.enc.json`); }

  async check(): Promise<boolean> {
    const { context, page } = await this.#browser();
    let status = await checkAuthentication(page);
    // Session cookies may disappear on a clean Chrome exit. Restore the encrypted
    // snapshot only if the persistent profile itself is no longer authenticated.
    if (!status.authenticated && this.#saved && !this.#restored) {
      this.#restored = true;
      await context.setStorageState(this.#saved.storageState);
      status = await checkAuthentication(page);
    }
    if (!status.authenticated) { this.#authenticated = false; return false; }
    assertAccount(status, this.#saved?.accountId ?? this.#accountId);
    this.#accountId = status.accountId;
    this.#authenticated = true;
    await this.#checkpoint();
    return true;
  }

  async #checkpoint() {
    if (!this.#authenticated || !this.#context || !this.#page || this.#page.isClosed() || !this.#accountId) return;
    const session = await captureSession(this.#context, this.#page, this.#config.provider, this.#accountId);
    await this.#save(this.#sessionFile(), session);
    this.#saved = session;
  }

  async login(onApproval: () => void, signal: AbortSignal): Promise<void> {
    this.#authenticated = false;
    const { context, page } = await this.#browser();
    let fallback: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await waitForAuthentication(context, {
        provider: this.#config.provider, headless: false, timeoutMs: this.#config.ttlMs, signal, onApproval,
      }, async () => {
        try {
          const target = await openProvider(page, this.#config.provider);
          if (target.isClosed()) return;
          await target.bringToFront();
          if (!trustedProviderUrl(target.url(), this.#config.provider)) return;
          if (this.#credentials) {
            const input = target.locator(this.#config.provider === "naver" ? 'input[name="id"]' : 'input[name="loginId"]');
            await input.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
            if (!target.isClosed() && await input.isVisible()) await submitCredentials(target, this.#config.provider, this.#credentials);
            else onApproval();
          } else onApproval();
        } finally {
          // Human control starts only after automatic input has finished.
          fallback = setTimeout(onApproval, 15_000);
        }
      });
      assertAccount(status, this.#saved?.accountId ?? this.#accountId);
      const verified = await checkAuthentication(page);
      assertAccount(verified, status.accountId);
      this.#accountId = verified.accountId;
      this.#authenticated = true;
      await this.#checkpoint();
    } finally { clearTimeout(fallback); }
  }

  // Reservation adapters use this exact authenticated context after human handoff.
  // The coordinator serializes access while a human login request is active.
  async withAuthenticatedPage<T>(action: (page: Page) => Promise<T>): Promise<T> {
    if (!await this.check()) throw new AuthError("NEEDS_LOGIN", "원격 로그인을 먼저 완료해 주세요.");
    const page = await this.#context!.newPage();
    try { return await action(page); }
    finally { await page.close(); await this.#checkpoint(); }
  }

  async close() {
    await this.#checkpoint().catch(() => {});
    await this.#context?.close(); this.#context = undefined; this.#page = undefined;
  }
}
