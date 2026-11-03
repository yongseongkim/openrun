import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { APP_ORIGIN, parseProvider, parseTimeout, secretsPath, sessionPath } from "./config.ts";
import { launchBrowser, newAuthContext, playwright } from "./browser.ts";
import { AuthError, publicError } from "./errors.ts";
import { decryptJson, initializeSecrets, runSops } from "./sops.ts";
import { credentialsFrom, loadCredentials } from "./credentials.ts";
import type { Credentials } from "./credentials.ts";
import { captureSession, loadSession, saveSession } from "./session.ts";
import { assertAccount, checkAuthentication, inspectProviderForm, openProvider, submitCredentials, waitForAuthentication } from "./catchtable.ts";

function report(value: object) { console.log(JSON.stringify(value)); }

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" }, secrets: { type: "string" }, headless: { type: "boolean", default: false },
      timeout: { type: "string" }, channel: { type: "string" }, "expected-account": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log("명령: doctor | secrets-init | secrets-check | probe | login | status\n옵션: --provider naver|kakao --secrets <SOPS 파일> --headless --timeout <초> --channel chrome --expected-account <계정 식별자>");
    return;
  }
  const provider = parseProvider(values.provider ?? process.env.CATCHTABLE_AUTH_PROVIDER);
  const timeoutMs = parseTimeout(values.timeout);
  if (command === "doctor") {
    const { chromium } = await playwright();
    await runSops(["--help"]);
    report({ status: "ENVIRONMENT", node: process.versions.node, sops: true,
      chromium: existsSync(chromium.executablePath()), provider,
      secretsPresent: existsSync(secretsPath(values.secrets)), sessionPresent: existsSync(sessionPath(provider)) });
    return;
  }
  if (command === "secrets-init") {
    await initializeSecrets(secretsPath(values.secrets));
    report({ status: "SECRETS_CREATED", message: "npm run secrets:edit으로 네이버 계정을 입력해 주세요." });
    return;
  }
  if (command === "secrets-check") {
    const decrypted = await decryptJson(secretsPath(values.secrets));
    let credentialsConfigured = false;
    try { credentialsFrom(decrypted, provider); credentialsConfigured = true; }
    catch (error) { if (!(error instanceof AuthError) || error.code !== "CREDENTIALS_MISSING") throw error; }
    report({ status: "SECRETS_DECRYPTED", provider, credentialsConfigured });
    return;
  }
  if (!["probe", "login", "status"].includes(command)) throw new AuthError("INVALID_COMMAND", "지원하지 않는 명령입니다. --help를 확인해 주세요.");
  const saved = command === "probe" ? undefined : await loadSession(sessionPath(provider), provider);
  if (command === "status" && !saved) throw new AuthError("NEEDS_LOGIN", "저장된 세션이 없습니다. npm run auth:login을 실행해 주세요.");
  let credentials: Credentials | undefined;
  if (command === "login" && !saved) credentials = await loadCredentials(provider, secretsPath(values.secrets));
  const browser = await launchBrowser({ headless: values.headless, channel: values.channel ?? "chrome" });
  const stop = () => { void browser.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const context = await newAuthContext(browser, saved);
    const page = await context.newPage();
    if (command === "probe") {
      const status = await checkAuthentication(page);
      if (status.authenticated) throw new AuthError("PROBE_NOT_ISOLATED", "새 브라우저에서 예상하지 않은 로그인 상태가 감지되었습니다.");
      const target = await openProvider(page, provider);
      await inspectProviderForm(target, provider);
      report({ status: "LOGIN_FORM_READY", provider, popup: target !== page, credentialsSubmitted: false });
      return;
    }
    const expected = values["expected-account"] ?? saved?.accountId;
    const current = await checkAuthentication(page);
    if (current.authenticated) {
      assertAccount(current, expected);
      await saveSession(sessionPath(provider), await captureSession(context, page, provider, current.accountId));
      report({ status: "AUTHENTICATED", provider, reusedSession: true });
      return;
    }
    if (command === "status") throw new AuthError("NEEDS_LOGIN", "저장된 캐치테이블 세션이 만료되었습니다. npm run auth:login을 실행해 주세요.");
    credentials ??= await loadCredentials(provider, secretsPath(values.secrets));
    const loginCredentials = credentials;
    report({ status: "LOGIN_STARTED", provider, message: "추가 인증 또는 동의 화면이 나오면 브라우저에서 완료해 주세요." });
    const authenticated = await waitForAuthentication(context, {
      provider, headless: values.headless, timeoutMs,
      onApproval: () => report({ status: "NEEDS_AUTH_APPROVAL", message: "브라우저에서 추가 인증을 완료해 주세요. 완료를 기다리고 있습니다." }),
    }, async () => {
      const target = await openProvider(page, provider);
      if (target.isClosed()) return;
      // A remembered provider session can return directly without a credential form.
      if (new URL(target.url()).origin === APP_ORIGIN) return;
      const username = target.locator(provider === "naver" ? 'input[name="id"]' : 'input[name="loginId"]');
      await username.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
      if (target.isClosed()) return;
      const hasForm = await username.isVisible();
      if (hasForm) {
        await submitCredentials(target, provider, loginCredentials);
        report({ status: "LOGIN_SUBMITTED", provider });
      }
      else if (values.headless) throw new AuthError("NEEDS_AUTH_APPROVAL", "로그인 제공자의 확인 화면이 필요합니다. 브라우저 모드로 실행해 주세요.");
    });
    assertAccount(authenticated, expected);
    // Verify once more through the Catchtable app before persisting any session.
    const verified = await checkAuthentication(page);
    assertAccount(verified, authenticated.accountId);
    await saveSession(sessionPath(provider), await captureSession(context, page, provider, verified.accountId));
    report({ status: "AUTHENTICATED", provider, reusedSession: false, sessionEncrypted: true });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await browser.close();
  }
}

try { await main(); }
catch (error) {
  report(publicError(error));
  process.exitCode = 1;
}
