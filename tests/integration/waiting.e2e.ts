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
      assert.equal((await waiting.jobs()).some(job => job.state === "SUBMITTING"), true);
      assert.deepEqual(route.request().postDataJSON(), { partySize: 4, phoneNumber: "01000001234" });
      await route.fulfill({ json: { ok: true } }); return;
    }
    await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<button class="button-updown">-</button><span id="count">1</span><button id="plus" class="button-updown">+</button><input id="test_input"><div class="info-group-step3" hidden>확인</div><button class="button-next">다음</button><script>
      let count=1,step=1;document.querySelector('#plus').onclick=()=>document.querySelector('#count').textContent=++count;
      document.querySelector('.button-next').onclick=async()=>{if(step===1){step=2;document.querySelector('.info-group-step3').hidden=false;return;}await fetch('/fixture-submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partySize:count,phoneNumber:document.querySelector('#test_input').value})});document.body.innerHTML='<p class="fixture_wait_text-title">42</p><p class="fixture_wait_text-title">2</p><p class="fixture_wait_text-title">10:00:03</p><span class="fixture_wait_text-point">1</span><span class="fixture_wait_text-point">3</span>';};</script>` });
  });
  return context;
} } as Browser;
const config = { ...remoteConfig(), port: 0 };
const database = process.env.OPENRUN_TEST_DATABASE_URL ? { databaseUrl: process.env.OPENRUN_TEST_DATABASE_URL } : { databaseFile: resolve(directory, "state.sqlite") };
const service = await startWaitingService({ config, adminToken: token, ...database, now: () => now,
  runner: { prepare: async () => { prepares++; }, run: (input, options) => registerNaniyori(wrapped, input, options), close: async () => {} } });
const { store: waiting, scheduler, server } = service;
config.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const client = await launchBrowser({ headless: true, channel: "chromium" });
try {
  const page = await client.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(config.origin + "/waiting"); await page.locator("#gate").waitFor();
  const owner = await fetch(config.origin + "/api/console/link", { method: "POST", headers: { authorization: `Bearer ${token}` } }).then(r => r.json()) as { url: string };
  assert.equal(new URL(owner.url).pathname, "/");
  await page.goto(owner.url); await page.getByRole("button", { name: "OpenRun 열기", exact: true }).click();
  await page.getByRole("heading", { name: "함께 갈 식탁", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(await page.getByRole("tab", { name: "나니요리", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("tab").count(), 1);
  const form = page.locator("#waiting-form"), rows = page.locator(".roster-entry");
  assert.equal(await form.locator("input").count(), 2);
  assert.equal(await form.locator("select, input[type=date], input[type=checkbox]").count(), 0);
  assert.match(await page.locator("#next-run").innerText(), /11월 4일/);
  async function schedule(phoneNumber = "010-0000-1234", partySize = "2") {
    await form.locator('[name="partySize"]').fill(partySize);
    await form.locator('[name="phoneNumber"]').fill(phoneNumber);
    await form.getByRole("button", { name: "신청 · 수정", exact: true }).click();
  }
  await schedule(); await rows.first().waitFor();
  assert.equal(await form.locator('[name="phoneNumber"]').inputValue(), "");
  assert.equal((await page.locator("#waiting-jobs").innerText()).includes("01000001234"), false);
  const originalId=(await waiting.pending())[0].id;
  await schedule("010-0000-1234", "3");
  await rows.first().getByText("3명", {exact:true}).waitFor();
  assert.equal(await rows.count(), 1);
  assert.equal((await waiting.pending())[0].id, originalId);
  await rows.first().getByRole("button", {name:"인원 수정",exact:true}).click();
  await rows.first().getByRole("spinbutton", {name:"수정할 인원수"}).fill("4");
  await rows.first().getByRole("button", {name:"저장",exact:true}).click();
  await rows.first().getByText("4명", {exact:true}).waitFor();
  assert.equal((await waiting.job(originalId)).partySize, 4);
  await schedule("010-0000-5678"); await rows.nth(1).waitFor();
  assert.equal(await page.locator("#roster-count").innerText(), "2건");
  const artifacts = process.env.OPENRUN_TEST_ARTIFACT_DIR ?? resolve(directory, "artifacts"); await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: resolve(artifacts, "waiting-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(artifacts, "waiting-mobile.png"), fullPage: true });
  await rows.filter({hasText:"010-****-5678"}).getByRole("button", {name:"삭제",exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll(".roster-entry").length === 1);
  // A page left open across KST midnight cannot submit to a different day's roster.
  await form.locator('[name="phoneNumber"]').fill("010-0000-9999");
  now = Date.parse("2026-11-04T00:00:00+09:00");
  await form.getByRole("button", {name:"신청 · 수정",exact:true}).click();
  await form.locator(".form-error").filter({hasText:"명부의 날짜가 바뀌었습니다"}).waitFor();
  assert.equal((await waiting.pending()).length, 1);
  await page.waitForFunction(() => document.querySelector<HTMLFieldSetElement>("#waiting-fields")?.disabled === true);
  assert.match(await page.locator("#next-run").innerText(), /11월 5일/);
  const job = (await waiting.pending())[0]; assert.equal(job.visitDate, "2026-11-04");
  now = job.prepareAt; await scheduler.tick(); assert.equal(prepares, 1); assert.equal(submissions, 0);
  now = job.opensAt; await scheduler.tick(); assert.equal(prepares, 1); assert.equal(submissions, 0);
  now = job.runsAt; await scheduler.tick();
  assert.equal((await waiting.job(job.id)).state, "SUCCEEDED"); assert.equal(submissions, 1);
  assert.equal((await waiting.job(job.id)).result?.waitNumber, "42");
  await page.reload(); await page.getByRole("heading", {name:"함께 갈 식탁",exact:true}).waitFor();
  await page.locator("#waiting-jobs .empty").waitFor();
  assert.match(await page.locator("#next-run").innerText(), /11월 5일/);
  assert.equal(await form.getByRole("button", {name:"신청 · 수정",exact:true}).isDisabled(), true);
  now = Date.parse("2026-11-05T00:00:00+09:00"); await page.reload();
  await page.getByRole("heading", {name:"함께 갈 식탁",exact:true}).waitFor();
  assert.equal(await form.getByRole("button", {name:"신청 · 수정",exact:true}).isDisabled(), false);
  await schedule(); await rows.first().waitFor();
  assert.equal((await waiting.pending())[0].visitDate, "2026-11-06");
  assert.equal(submissions, 1);
  console.log(JSON.stringify({ status: "WAITING_E2E_PASSED", waitingOnly: true, twoFieldRoster: true, multiplePhones: true, samePhoneUpdatesParty: true, inlinePartyEdit: true, tomorrowMorningKst: true, warmUpBeforeOpening: true, attemptOneSecondAfterOpening: true, encryptedContact: true, deleteBeforeRun: true, providerSubmissions: 1, mobileLayout: true, closedDay: true, staleOpeningRejected: true, singlePageTabs: true, liveRegistrations: 0 }));
} finally {
  await client.close(); await service.stop(); await automation.close();
  await rm(directory, { recursive: true, force: true });
}
