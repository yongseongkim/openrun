// Run inside the Docker image: genuine Chrome + Xvfb + x11vnc + noVNC.
// Every restaurant/provider request is intercepted; no real account or Slack is used.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext } from "playwright";
import { APP_ORIGIN, INIT_URL } from "../../src/config.ts";
import { launchBrowser } from "../../src/browser.ts";
import { checkAuthentication } from "../../src/catchtable.ts";
import type { SavedSession } from "../../src/session.ts";
import { remoteConfig } from "../../src/remote/config.ts";
import { PersistentAuthWorker } from "../../src/remote/worker.ts";
import { AuthCoordinator } from "../../src/remote/coordinator.ts";
import { createRemoteServer } from "../../src/remote/server.ts";
import { GrantStore } from "../../src/remote/grants.ts";
import { AppStore } from "../../src/app/store.ts";
import { BookingScheduler } from "../../src/app/scheduler.ts";

const temporary = await mkdtemp(resolve(tmpdir(), "openrun-remote-e2e-"));
let snapshot: SavedSession | undefined;
let submissions = 0;
let remoteInput = "";
let originalContext: BrowserContext | undefined;
let reservationInput = "";

async function fixtures(context: BrowserContext) {
  originalContext ??= context;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin + url.pathname === INIT_URL) {
      const signedIn = (await context.cookies(INIT_URL)).some((cookie) => cookie.name === "fixture_auth");
      await route.fulfill({ json: { resultCode: "CT_OK", data: { auth: { isLogin: signedIn, currentUser: { loggedIn: signedIn, ctUserIdentifier: signedIn ? "fixture-account" : "" } } } }, headers: { "access-control-allow-origin": APP_ORIGIN, "access-control-allow-credentials": "true" } });
    } else if (url.origin === APP_ORIGIN && url.pathname === "/fixture-booking") {
      reservationInput = (await route.request().postDataJSON()).value;
      await route.fulfill({ json: { ok: reservationInput === "confirm-fixture" } });
    } else if (url.origin === APP_ORIGIN && url.pathname.startsWith("/ct/shop/")) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<h1>Reservation fixture — no live booking</h1><form id="booking"><input id="booking-input" autofocus><button>예약하기</button></form><p id="result"></p><script>document.querySelector('#booking').onsubmit=async e=>{e.preventDefault();const r=await fetch('/fixture-booking',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:document.querySelector('#booking-input').value})}).then(r=>r.json());if(r.ok)document.querySelector('#result').textContent='Fixture confirmed';};</script>` });
    } else if (url.origin === APP_ORIGIN) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<button onclick="window.open('https://nid.naver.com/oauth2.0/authorize')">네이버로 시작</button><script>fetch('${INIT_URL}',{credentials:'include'})</script>` });
    } else if (url.origin === "https://nid.naver.com" && url.pathname === "/fixture-submit") {
      submissions += 1; await route.fulfill({ json: { ok: true } });
    } else if (url.origin === "https://nid.naver.com" && url.pathname === "/fixture-confirm") {
      remoteInput = (await route.request().postDataJSON()).value;
      if (remoteInput === "approve") await context.addCookies([{ name: "fixture_auth", value: "yes", domain: ".catchtable.co.kr", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
      await route.fulfill({ json: { ok: remoteInput === "approve" } });
    } else if (url.origin === "https://nid.naver.com") {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><body style="font:20px sans-serif;padding:30px;background:#eef4ea"><h1>OpenRun remote input fixture</h1><form id="login"><input name="id"><input name="pw" type="password"><button id="loginBtn_column">로그인</button></form><form id="approval" hidden><h2>추가 인증</h2><label>Test approval <input id="confirmation" autocomplete="off"></label><button>Continue</button></form><script>
        document.querySelector('#login').onsubmit=async e=>{e.preventDefault();await fetch('/fixture-submit',{method:'POST'});document.querySelector('#login').hidden=true;document.querySelector('#approval').hidden=false;document.querySelector('#confirmation').focus();};
        document.querySelector('#approval').onsubmit=async e=>{e.preventDefault();const r=await fetch('/fixture-confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:document.querySelector('#confirmation').value})}).then(r=>r.json());if(r.ok){window.opener.location='${APP_ORIGIN}';window.close();}};
      </script></body></html>` });
    } else await route.fulfill({ status: 404, body: "No live network in this test" });
  });
}

const config = remoteConfig({ OPENRUN_PUBLIC_URL: "http://127.0.0.1:4341", OPENRUN_PORT: "4341", OPENRUN_PROFILE_DIR: resolve(temporary, "profiles"), OPENRUN_AUTH_DIR: resolve(temporary, ".auth"), OPENRUN_BROWSER_CHANNEL: "chromium" });
const overrides = { setup: fixtures, save: async (_file: string, value: SavedSession) => { snapshot = structuredClone(value); }, load: async () => snapshot };
let worker = new PersistentAuthWorker(config, { username: "fixture-user", password: "fixture-password" }, overrides);
let coordinator = new AuthCoordinator(worker, 60_000);
const store = new AppStore(resolve(temporary, "app.sqlite")); store.seed();
let now = Date.now();
const scheduler = new BookingScheduler(store, coordinator, { now: () => now });
const server = createRemoteServer({ config, coordinator, grants: new GrantStore(), store, adminToken: "fixture-only-admin-key-at-least-32-characters" });
server.listen(config.port, "127.0.0.1"); await once(server, "listening");
const client = await launchBrowser({ headless: true, channel: "chromium" });
try {
  const response = await fetch(config.origin + "/api/auth/ensure", { method: "POST", headers: { "authorization": "Bearer fixture-only-admin-key-at-least-32-characters", "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 202);
  const result = await response.json() as { loginUrl: string; request: { id: string } };
  const context = await client.newContext({ viewport: { width: 1200, height: 1100 } });
  const page = await context.newPage();
  await page.goto(result.loginUrl);
  await page.getByRole("button", { name: "서버 브라우저 열기", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "브라우저 연결됨" }).waitFor({ timeout: 30_000 });
  await page.locator("#screen canvas").waitFor();
  await delay(1000);
  const artifacts = process.env.OPENRUN_TEST_ARTIFACT_DIR ?? resolve(temporary, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: resolve(artifacts, "remote-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(artifacts, "mobile-desktop.png"), fullPage: true });

  // Real noVNC keyboard events travel through the authenticated WebSocket and
  // x11vnc into the server Chrome's currently focused fixture input.
  await page.getByRole("button", { name: "키보드", exact: true }).click();
  await page.getByLabel("문자 입력", { exact: true }).fill("approve");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.getByRole("heading", { name: "로그인이 완료됐습니다." }).waitFor({ timeout: 30_000 });
  assert.equal(remoteInput, "approve");
  assert.equal((await coordinator.wait(result.request.id)).state, "AUTHENTICATED");
  assert.equal(submissions, 1);
  const reused = await coordinator.withAuthenticatedPage(async (automationPage) => {
    const status = await checkAuthentication(automationPage);
    return status.authenticated && automationPage.context() === originalContext;
  });
  assert.equal(reused, true);
  await page.setViewportSize({ width: 1200, height: 1100 });
  await page.screenshot({ path: resolve(artifacts, "login-complete.png"), fullPage: true });

  // Mobile layout and the cookie-bound completion screen remain usable after
  // removing the original one-use fragment token.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(artifacts, "mobile-complete.png"), fullPage: true });
  assert.equal(new URL(page.url()).hash, "");

  // The owner opens the actual management UI and registers an armed request.
  const ownerLink = await fetch(config.origin + "/api/console/link", { method:"POST",headers:{authorization:"Bearer fixture-only-admin-key-at-least-32-characters"} }).then(r=>r.json()) as { url:string };
  await page.goto(ownerLink.url);
  await page.getByRole("button", { name:"나의 목록 열기",exact:true }).click();
  await page.locator(".card").first().waitFor();
  assert.equal(await page.locator(".card").count(),3);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(artifacts,"catalog-mobile.png"),fullPage:true});
  await page.setViewportSize({width:1280,height:1000});
  await page.screenshot({path:resolve(artifacts,"catalog-desktop.png"),fullPage:true});
  await page.getByRole("searchbox").fill("윤남노"); assert.equal(await page.locator(".card").count(),1);
  await page.getByRole("button",{name:"예약 요청",exact:true}).click();
  const form=page.locator("#booking-form");
  const visit=new Date(now+30*86400000).toISOString().slice(0,10);
  const opening=new Date(now+9*3600000+60000).toISOString().slice(0,16);
  await form.locator('[name="diningDate"]').fill(visit);
  await form.locator('[name="opensAt"]').fill(opening);
  await form.getByRole("button",{name:"실행 등록",exact:true}).click();
  await page.getByText("실행 대기",{exact:true}).waitFor();
  const job=store.jobs()[0]; assert.equal(job.state,"SCHEDULED");assert.equal(job.diningDate,visit);assert.equal(job.partySize,2);
  await scheduler.tick();
  now=job.opensAt;
  const readyUntil=Date.now()+30000;
  while(store.job(job.id).state!=="READY") {
    void scheduler.tick();
    if(Date.now()>readyUntil)throw new Error("Reservation did not become ready");
    await delay(100);
  }
  await page.getByRole("button",{name:"서버 예약 화면 열기",exact:true}).waitFor();
  const popupEvent=page.waitForEvent("popup");
  await page.getByRole("button",{name:"서버 예약 화면 열기",exact:true}).click();
  const bookingViewer=await popupEvent;
  await bookingViewer.getByRole("button",{name:"서버 브라우저 열기",exact:true}).click();
  await bookingViewer.getByRole("status").filter({hasText:"브라우저 연결됨"}).waitFor({timeout:30000});
  await bookingViewer.locator("#booking-summary").filter({hasText:visit}).waitFor();
  await bookingViewer.getByRole("button",{name:"키보드",exact:true}).click();
  await bookingViewer.getByLabel("문자 입력",{exact:true}).fill("confirm-fixture");
  await bookingViewer.getByRole("button",{name:"Enter",exact:true}).click();
  const fixtureUntil=Date.now()+10000;
  while(reservationInput!=="confirm-fixture") {if(Date.now()>fixtureUntil)throw new Error("Reservation input not delivered");await delay(50);}
  await bookingViewer.screenshot({path:resolve(artifacts,"reservation-desktop.png"),fullPage:true});
  await bookingViewer.getByRole("checkbox").check();
  await bookingViewer.getByRole("button",{name:"예약 내역 확인 완료 · 화면 닫기",exact:true}).click();
  await bookingViewer.getByRole("heading",{name:"예약 화면 접속을 종료했습니다.",exact:true}).waitFor();
  await scheduler.tick(); assert.equal(store.job(job.id).state,"COMPLETED");
  await scheduler.close(); await bookingViewer.close();
  await coordinator.close();
  worker = new PersistentAuthWorker(config, undefined, overrides);
  assert.equal(await worker.check(), true);
  assert.equal(submissions, 1);
  await worker.close();
  console.log(JSON.stringify({ status: "REMOTE_E2E_PASSED", realVncInput: true, sameBrowserHandoff: true, restoredAfterBrowserRestart: true, loginSubmissions: submissions, catalogUi: true, scheduledReservationHandoff: true, liveReservations: 0 }));
} finally {
  await scheduler.close(); await client.close(); await coordinator.close(); await worker.close(); store.close();
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
}
