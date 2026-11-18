// Boot the real waiting entrypoint, persist a future web request, and restart.
// Disposable owner key/contact/DB only; no KMS, Catchtable, Slack or live waiting.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ROOT } from "../../src/config.ts";

const directory = await mkdtemp(resolve(tmpdir(), "openrun-waiting-daemon-"));
const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
const port = (listener.address() as { port: number }).port;
await new Promise<void>(done => listener.close(() => done()));
const origin = `http://127.0.0.1:${port}`, publicOrigin = "https://openrun-fixture.example";
const key = "waiting-daemon-disposable-owner-key-for-fixtures";
const databaseUrl = process.env.OPENRUN_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openrun_test")) throw new Error("Use npm run test:postgres with its disposable test database");
const env = { ...process.env, OPENRUN_HOST: "127.0.0.1", OPENRUN_PORT: String(port), OPENRUN_DATA_DIR: directory,
  OPENRUN_PUBLIC_URL: publicOrigin, OPENRUN_API_URL: origin, OPENRUN_ADMIN_TOKEN: key,
  OPENRUN_SECRETS_FILE: "", SLACK_WEBHOOK_URL: "", CATCHTABLE_AUTH_PROVIDER: "naver", DATABASE_URL: databaseUrl };
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
let child: ChildProcess | undefined;
async function boot() {
  child = spawn(process.execPath, ["--import", resolve(ROOT, "tests/fixtures/waiting-clock.ts"), resolve(ROOT, "src/waiting/main.ts")], { cwd: ROOT, env, stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, "Waiting daemon exited before becoming ready");
    try { if ((await fetch(origin + "/healthz", { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(50);
  }
  throw new Error("Waiting daemon did not become ready");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null) { child.kill("SIGKILL"); await exited; throw new Error("Waiting daemon did not shut down cleanly"); }
  assert.equal(child.exitCode, 0);
}
try {
  await boot();
  assert.equal((await fetch(origin + "/")).status, 200);
  assert.equal((await fetch(origin + "/waiting", {redirect:"manual"})).headers.get("location"), "/");
  const { stdout } = await promisify(execFile)(process.execPath, [resolve(ROOT, "src/remote/command.ts"), "console"], { cwd: ROOT, env, timeout: 10_000, encoding: "utf8" });
  const link = new URL((JSON.parse(stdout) as { url: string }).url);
  assert.equal(link.origin, publicOrigin); assert.equal(link.pathname, "/");
  const overview = await fetch(origin + "/api/app/waiting", { headers }).then(r => r.json()) as { nextOpening: { id: string } };
  const response = await fetch(origin + "/api/app/waiting", { method: "POST", headers, body: JSON.stringify({
    openingId: overview.nextOpening.id, partySize: 2,
    phoneNumber: "01000001234", confirmed: true, notify: false,
  }) });
  assert.equal(response.status, 200);
  const saved = (await response.json() as { job: { id: string; prepareAt: number } }).job;
  assert.ok(saved.prepareAt > Date.parse("2026-11-03T21:00:00+09:00")); // Child time remains frozen before preparation.
  await stop(); await boot();
  const after = await fetch(origin + "/api/app/waiting", { headers }).then(r => r.text());
  const jobs = (JSON.parse(after) as { jobs: { id: string; state: string }[] }).jobs;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].id, saved.id); assert.equal(jobs[0].state, "SCHEDULED");
  assert.equal(after.includes("01000001234"), false); assert.equal(after.includes("phoneCiphertext"), false);
  console.log(JSON.stringify({ status: "WAITING_DAEMON_E2E_PASSED", noCatchtable: true, persistedAfterRestart: true, internalCliWithPublicUrl: true, liveRegistrations: 0 }));
} finally { await stop(); await rm(directory, { recursive: true, force: true }); }
