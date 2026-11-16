// Owner UI → durable request → scheduled Syrup browser → result, all fixtures.
// No real restaurant, account, phone recipient, KMS or Slack is contacted.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions } from "playwright";
import { launchBrowser } from "../../src/browser.ts";
import { registerNaniyori } from "../../src/waiting/syrup.ts";
import { remoteConfig } from "../../src/remote/config.ts";
import { startWaitingService } from "../../src/waiting/service.ts";

const directory = await mkdtemp(resolve(tmpdir(), "openrun-waiting-e2e-"));
const token = "waiting-e2e-owner-token-with-sufficient-entropy";
let now = Date.parse("2026-11-03T21:00:00+09:00"), submissions = 0, prepares = 0;
const automation = await launchBrowser({ headless: true, channel: "chromium" });
const wrapped = { newContext: async (options: BrowserContextOptions) => {
  const context = await automation.newContext(options);
  await context.route("**/*", async route => {
    if (new URL(route.request().url()).pathname === "/fixture-submit") {
      submissions++;
      assert.equal(waiting.jobs().some(job => job.state === "SUBMITTING"), true);
      assert.deepEqual(route.request().postDataJSON(), { partySize: 2, phoneNumber: "01000001234" });
      await route.fulfill({ json: { ok: true } }); return;
    }
    await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<button class="button-updown">-</button><span id="count">1</span><button id="plus" class="button-updown">+</button><input id="test_input"><div class="info-group-step3" hidden>확인</div><button class="button-next">다음</button><script>
      let count=1,step=1;document.querySelector('#plus').onclick=()=>document.querySelector('#count').textContent=++count;
      document.querySelector('.button-next').onclick=async()=>{if(step===1){step=2;document.querySelector('.info-group-step3').hidden=false;return;}await fetch('/fixture-submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partySize:count,phoneNumber:document.querySelector('#test_input').value})});document.body.innerHTML='<p class="fixture_wait_text-title">42</p><p class="fixture_wait_text-title">2</p><p class="fixture_wait_text-title">10:00:03</p><span class="fixture_wait_text-point">1</span><span class="fixture_wait_text-point">3</span>';};</script>` });
  });
  return context;
} } as Browser;
const config = { ...remoteConfig(), port: 0 };
const service = await startWaitingService({ config, adminToken: token, databaseFile: resolve(directory, "state.sqlite"), now: () => now,
  runner: { prepare: async () => { prepares++; }, run: (input, options) => registerNaniyori(wrapped, input, options), close: async () => {} } });
const { store: waiting, scheduler, server } = service;
config.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const client = await launchBrowser({ headless: true, channel: "chromium" });
try {
  const page = await client.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(config.origin + "/waiting"); await page.locator("#gate").waitFor();
  const owner = await fetch(config.origin + "/api/console/link", { method: "POST", headers: { authorization: `Bearer ${token}` } }).then(r => r.json()) as { url: string };
  assert.equal(new URL(owner.url).pathname, "/waiting");
  await page.goto(owner.url); await page.getByRole("button", { name: "나의 웨이팅 열기", exact: true }).click();
  await page.getByRole("heading", { name: "나니요리, 언제 갈까요?", exact: true }).waitFor();
  assert.equal(await page.locator("#catchtable-nav").isVisible(), false);
  const form = page.locator("#waiting-form");
  assert.equal(await form.locator('[name="visitDate"]').inputValue(), "2026-11-04");
  assert.equal(await form.locator('[name="notify"]').isChecked(), false);
  await form.locator('[name="visitDate"]').fill("2026-11-06");
  async function schedule() {
    await form.locator('[name="partySize"]').fill("2");
    await form.locator('[name="phoneNumber"]').fill("010-0000-1234");
    await form.locator('[name="confirmed"]').check();
    await form.getByRole("button", { name: "웨이팅 신청", exact: true }).click();
  }
  await schedule(); await page.locator(".badge").filter({ hasText: "실행 대기" }).waitFor();
  assert.equal(await form.locator('[name="phoneNumber"]').inputValue(), "");
  assert.equal((await page.locator("#waiting-jobs").innerText()).includes("01000001234"), false);
  await page.getByRole("button", { name: "신청 취소", exact: true }).click();
  await page.locator(".badge").filter({ hasText: "신청 취소" }).waitFor();
  await schedule(); await page.locator(".badge").filter({ hasText: "실행 대기" }).waitFor();
  const job = waiting.pending()[0]; assert.equal(job.visitDate, "2026-11-06");
  now = job.prepareAt; await scheduler.tick(); assert.equal(prepares, 1); assert.equal(submissions, 0);
  now = job.opensAt; await scheduler.tick(); assert.equal(prepares, 1); assert.equal(submissions, 0);
  now = job.runsAt;
  await scheduler.tick();
  assert.equal(waiting.job(job.id).state, "SUCCEEDED"); assert.equal(submissions, 1);
  await page.locator(".badge").filter({ hasText: "웨이팅 등록 완료" }).waitFor();
  await page.locator(".waiting-result strong").filter({ hasText: "42" }).waitFor();
  await page.reload(); await page.locator(".waiting-result strong").filter({ hasText: "42" }).waitFor();
  const artifacts = process.env.OPENRUN_TEST_ARTIFACT_DIR ?? resolve(directory, "artifacts"); await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: resolve(artifacts, "waiting-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(artifacts, "waiting-mobile.png"), fullPage: true });
  now = Date.parse("2026-11-04T21:00:00+09:00"); await page.reload();
  await page.getByRole("heading", { name: "나니요리, 언제 갈까요?", exact: true }).waitFor();
  assert.equal(await form.locator('[name="visitDate"]').inputValue(), "2026-11-06");
  await form.locator('[name="visitDate"]').fill("2026-11-05");
  await page.locator("#closed-notice").waitFor();
  assert.equal(await form.getByRole("button", { name: "웨이팅 신청", exact: true }).isDisabled(), true);
  assert.equal(await form.locator('[name="visitDate"]').isDisabled(), false);
  await form.locator('[name="visitDate"]').fill("2026-11-06");
  assert.equal(await form.getByRole("button", { name: "웨이팅 신청", exact: true }).isDisabled(), false);
  await scheduler.tick(); assert.equal(submissions, 1);
  now = Date.parse("2026-11-05T21:00:00+09:00"); await page.reload();
  await form.locator('[name="confirmed"]').check();
  now = Date.parse("2026-11-06T21:00:00+09:00");
  await page.waitForFunction(() => Array.from(document.querySelectorAll("input")).some(input => input.name === "visitDate" && input.value === "2026-11-07"));
  assert.equal(await form.locator('[name="confirmed"]').isChecked(), false);
  console.log(JSON.stringify({ status: "WAITING_E2E_PASSED", waitingOnly: true, ownerUi: true, futureDateKst: true, warmUpBeforeOpening: true, attemptOneSecondAfterOpening: true, encryptedContact: true, cancelBeforeRun: true, providerSubmissions: 1, reloadedResult: true, mobileLayout: true, closedDay: true, renewedDateConsent: true, liveRegistrations: 0 }));
} finally {
  await client.close(); await service.stop(); await automation.close();
  await rm(directory, { recursive: true, force: true });
}
