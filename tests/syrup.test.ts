import test from "node:test";
import assert from "node:assert/strict";
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";
import { launchBrowser } from "../src/browser.ts";
import { registerNaniyori } from "../src/waiting/syrup.ts";

const input = { partySize: 3, phoneNumber: "01000001234" };
async function fixture(browser: Browser, mode: "ok" | "lost" | "closed" | "origin" | "captcha" | "wrong_result" = "ok") {
  let submissions = 0, navigations = 0, captured: unknown, context: BrowserContext | undefined;
  const wrapped = { newContext: async (options: BrowserContextOptions) => {
    context = await browser.newContext(options);
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/fixture-submit") { submissions++; captured = route.request().postDataJSON(); await route.fulfill({ json: { ok: mode !== "lost" } }); return; }
      navigations++;
      if (mode === "origin" && url.origin !== "https://unexpected.example") { await route.fulfill({ contentType: "text/html", body: '<script>location.replace("https://unexpected.example")</script>' }); return; }
      if (mode === "closed") { await route.fulfill({ contentType: "text/html", body: "Reception Closed" }); return; }
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><body>${mode === "captcha" ? '<div class="g-recaptcha">Human verification fixture</div>' : ''}
        <button class="button-updown" id="minus">-</button><span id="count">1</span><button class="button-updown" id="plus">+</button><input id="test_input"><div class="info-group-step3" hidden>확인</div><button class="button-next">다음</button>
        <script>let count=1,step=1;document.querySelector('#plus').onclick=()=>document.querySelector('#count').textContent=++count;
        document.querySelector('.button-next').onclick=async()=>{if(step===1){step=2;document.querySelector('.info-group-step3').hidden=false;return;}const r=await fetch('/fixture-submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partySize:count,phoneNumber:document.querySelector('#test_input').value})}).then(r=>r.json());if(r.ok)document.body.innerHTML='<p class="hash_wait_text-title">${mode === "wrong_result" ? "01000001234" : "42"}</p><p class="hash_wait_text-title">2</p><p class="hash_wait_text-title">10:00:03</p><span class="hash_wait_text-point">1</span><span class="hash_wait_text-point">3</span>';};</script></body></html>` });
    });
    return context;
  } } as Browser;
  return { browser: wrapped, submissions: () => submissions, navigations: () => navigations, captured: () => captured, closed: () => context?.pages().length === 0 };
}

test("migrated Syrup flow enters party/phone, crosses one durable boundary, and reads confirmation", async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const server = await fixture(browser); let boundaries = 0;
    const result = await registerNaniyori(server.browser, input, { beforeSubmit: () => { boundaries++; assert.equal(server.submissions(), 0); } });
    assert.deepEqual(result, { waitNumber: "42", teamsAhead: "3", registrationTime: "10:00:03" });
    assert.equal(boundaries, 1); assert.equal(server.submissions(), 1); assert.deepEqual(server.captured(), input); assert.equal(server.closed(), true);
  } finally { await browser.close(); }
});

test("an unreadable result after final submission never opens a fallback tab or submits twice", async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const server = await fixture(browser, "lost");
    await assert.rejects(() => registerNaniyori(server.browser, input, { beforeSubmit: () => {}, resultTimeoutMs: 60 }));
    assert.equal(server.submissions(), 1); assert.equal(server.navigations(), 1); assert.equal(server.closed(), true);
  } finally { await browser.close(); }
});

test("a changed result layout cannot return a phone as the waiting number", async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const server = await fixture(browser, "wrong_result");
    await assert.rejects(() => registerNaniyori(server.browser, input, { beforeSubmit: () => {} }), { code: "WAITING_RESULT_UNCONFIRMED" });
    assert.equal(server.submissions(), 1); assert.equal(server.closed(), true);
  } finally { await browser.close(); }
});

test("a failed durable boundary prevents the final provider request", async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const server = await fixture(browser);
    await assert.rejects(() => registerNaniyori(server.browser, input, { beforeSubmit: () => { throw new Error("Database unavailable"); } }));
    assert.equal(server.submissions(), 0); assert.equal(server.closed(), true);
  } finally { await browser.close(); }
});

test("closed reception retries only discovery and stops after a bounded number of visits", async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    const server = await fixture(browser, "closed");
    await assert.rejects(() => registerNaniyori(server.browser, input, { beforeSubmit: () => {}, discoveryTimeoutMs: 30 }));
    assert.equal(server.navigations(), 3); assert.equal(server.submissions(), 0); assert.equal(server.closed(), true);
  } finally { await browser.close(); }
});

test("unexpected origins and human verification stop before contact submission", async () => {
  const browser = await launchBrowser({ headless: true });
  try {
    for (const mode of ["origin", "captcha"] as const) {
      const server = await fixture(browser, mode);
      await assert.rejects(() => registerNaniyori(server.browser, input, { beforeSubmit: () => {} }), { code: mode === "origin" ? "WAITING_UNEXPECTED_ORIGIN" : "WAITING_NEEDS_APPROVAL" });
      assert.equal(server.submissions(), 0); assert.equal(server.closed(), true);
    }
  } finally { await browser.close(); }
});
