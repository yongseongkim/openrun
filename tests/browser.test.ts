import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext } from "playwright";
import { launchBrowser, newAuthContext } from "../src/browser.ts";
import { APP_ORIGIN, INIT_URL } from "../src/config.ts";
import type { Provider } from "../src/config.ts";
import { assertAccount, checkAuthentication, openProvider, submitCredentials, waitForAuthentication } from "../src/catchtable.ts";
import { captureSession } from "../src/session.ts";

const cookie = { name: "testSession", value: "account-one", domain: ".catchtable.co.kr", path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const };

async function fixtures(context: BrowserContext, mode: "success" | "approval" | "captcha" | "rejected" = "success") {
  let submissions = 0;
  let lastSubmission: unknown;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { "access-control-allow-origin": APP_ORIGIN, "access-control-allow-credentials": "true" };
    if (url.origin + url.pathname === INIT_URL) {
      const session = (await context.cookies(INIT_URL)).find((item) => item.name === cookie.name);
      await route.fulfill({ json: { resultCode: "CT_OK", data: { auth: {
        isLogin: Boolean(session), currentUser: { loggedIn: Boolean(session), ctUserIdentifier: session?.value ?? "" },
      } } }, headers });
      return;
    }
    if (url.origin === APP_ORIGIN) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="ko"><body>
        <button onclick="window.open('https://nid.naver.com/oauth2.0/authorize')">네이버로 시작</button>
        <button onclick="window.open('https://accounts.kakao.com/login')">카카오로 시작</button>
        <script>
          sessionStorage.setItem('fixture', 'preserved');
          fetch('${INIT_URL}', {credentials:'include'});
        </script></body></html>` });
      return;
    }
    if (["https://nid.naver.com", "https://accounts.kakao.com"].includes(url.origin)) {
      if (url.pathname === "/test-submit") {
        submissions += 1;
        lastSubmission = JSON.parse(request.postData() ?? "{}");
        if (mode === "success") await context.addCookies([cookie]);
        await route.fulfill({ json: { mode } });
        return;
      }
      const naver = url.hostname === "nid.naver.com";
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="ko"><body>
        <form>
          <input name="${naver ? "id" : "loginId"}" id="id">
          <input name="${naver ? "pw" : "password"}" type="password" id="pw">
          <input name="${naver ? "nvlong" : "saveSignedIn"}" id="${naver ? "loginStay" : "saveSignedIn"}" type="checkbox">
          <button type="submit" ${naver ? 'id="loginBtn_column"' : ""}>로그인</button>
        </form><div id="message"></div><script>
          document.querySelector('form').onsubmit = async (event) => {
            event.preventDefault();
            const result = await fetch('/test-submit', {method:'POST',body:JSON.stringify({username:document.querySelector('#id').value,password:document.querySelector('#pw').value,remember:document.querySelector('input[type=checkbox]').checked})}).then(r=>r.json());
            if(result.mode==='success') { window.opener.location='${APP_ORIGIN}/'; window.close(); }
            if(result.mode==='approval') { document.querySelector('form').hidden=true; document.querySelector('#message').innerText='2단계 인증 요청을 승인해 주세요'; }
            if(result.mode==='captcha') { document.querySelector('form').hidden=true; document.querySelector('#message').innerHTML='<input name="captcha_value" placeholder="Enter text">'; }
            if(result.mode==='rejected') document.querySelector('#message').innerText='아이디 또는 비밀번호를 확인해 주세요';
          };
        </script></body></html>` });
      return;
    }
    // No browser test request is allowed to reach a live site.
    await route.fulfill({ status: 404, body: "fixture unavailable" });
  });
  return { submissions: () => submissions, lastSubmission: () => lastSubmission };
}

for (const provider of ["naver", "kakao"] satisfies Provider[]) {
  test(`${provider}: OAuth popup submits once and a fresh context restores the verified session`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser({ headless: true });
    try {
      const context = await newAuthContext(browser);
      const server = await fixtures(context);
      const page = await context.newPage();
      assert.deepEqual(await checkAuthentication(page), { authenticated: false });
      const result = await waitForAuthentication(context, { provider, headless: true, timeoutMs: 10_000 }, async () => {
        const popup = await openProvider(page, provider);
        assert.notEqual(popup, page);
        await submitCredentials(popup, provider, { username: "fixture-user", password: "fixture-password" });
      });
      assertAccount(result, "account-one");
      const verified = await checkAuthentication(page);
      assertAccount(verified, "account-one");
      await page.evaluate(() => {
        sessionStorage.setItem("restore-only", "captured-session-value");
        localStorage.setItem("restore-local", "captured-local-value");
      });
      const session = await captureSession(context, page, provider, verified.accountId);
      assert.equal(server.submissions(), 1);
      assert.deepEqual(server.lastSubmission(), { username: "fixture-user", password: "fixture-password", remember: true });
      assert.equal(session.sessionStorage[APP_ORIGIN].fixture, "preserved");
      await context.close();

      const fresh = await newAuthContext(browser, session);
      await fixtures(fresh);
      const restored = await fresh.newPage();
      assertAccount(await checkAuthentication(restored), session.accountId);
      assert.equal(await restored.evaluate(() => sessionStorage.getItem("restore-only")), "captured-session-value");
      assert.equal(await restored.evaluate(() => localStorage.getItem("restore-local")), "captured-local-value");
      await fresh.clearCookies();
      assert.deepEqual(await checkAuthentication(restored), { authenticated: false });
    } finally { await browser.close(); }
  });
}

test("headless verification challenge reports approval required without retrying credentials", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const context = await newAuthContext(browser);
    const server = await fixtures(context, "approval");
    const page = await context.newPage();
    await assert.rejects(() => waitForAuthentication(context, { provider: "naver", headless: true, timeoutMs: 5_000 }, async () => {
      const popup = await openProvider(page, "naver");
      await submitCredentials(popup, "naver", { username: "fixture-user", password: "fixture-password" });
    }), { code: "NEEDS_AUTH_APPROVAL" });
    assert.equal(server.submissions(), 1);
    assert.deepEqual(await checkAuthentication(page), { authenticated: false });
  } finally { await browser.close(); }
});

test("rejected credentials are reported once without a login retry", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const context = await newAuthContext(browser);
    const server = await fixtures(context, "rejected");
    const page = await context.newPage();
    await assert.rejects(() => waitForAuthentication(context, { provider: "naver", headless: true, timeoutMs: 5_000 }, async () => {
      const popup = await openProvider(page, "naver");
      await submitCredentials(popup, "naver", { username: "fixture-user", password: "fixture-password" });
    }), { code: "LOGIN_REJECTED" });
    assert.equal(server.submissions(), 1);
  } finally { await browser.close(); }
});

test("a CAPTCHA without explanatory text is detected and can be completed interactively", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const context = await newAuthContext(browser);
    const server = await fixtures(context, "captcha");
    const page = await context.newPage();
    let approvals = 0;
    let acknowledge!: () => void;
    const challenge = new Promise<void>((resolve) => { acknowledge = resolve; });
    const userCompletion = challenge.then(async () => {
      // Simulate the user's successful approval; the worker never solves a CAPTCHA.
      await context.addCookies([cookie]);
      await page.goto(APP_ORIGIN);
    });
    const authentication = waitForAuthentication(context, {
      provider: "naver", headless: false, timeoutMs: 5_000,
      onApproval: () => { approvals += 1; acknowledge(); },
    }, async () => {
      const popup = await openProvider(page, "naver");
      await submitCredentials(popup, "naver", { username: "fixture-user", password: "fixture-password" });
    });
    const [status] = await Promise.all([authentication, userCompletion]);
    assertAccount(status, "account-one");
    assert.equal(approvals, 1);
    assert.equal(server.submissions(), 1);
  } finally { await browser.close(); }
});

test("the password is not entered into an unexpected provider origin", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const context = await newAuthContext(browser);
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<input name="id"><input name="pw" type="password">' }));
    const page = await context.newPage();
    await page.goto("https://nid.naver.com.evil.example/");
    await assert.rejects(() => submitCredentials(page, "naver", { username: "fixture-user", password: "fixture-password" }), { code: "UNEXPECTED_LOGIN_ORIGIN" });
    assert.equal(await page.locator('input[name="pw"]').inputValue(), "");
  } finally { await browser.close(); }
});
