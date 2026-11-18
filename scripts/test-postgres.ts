// Every test run owns a fresh, temporary PostgreSQL container. Never use homelab data.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { ROOT } from "../src/config.ts";

const exec = promisify(execFile);
const password = randomBytes(24).toString("hex");
const image = process.env.OPENRUN_POSTGRES_TEST_IMAGE;
let container: string | undefined, admin: Pool | undefined;
async function suite(args: string[], database: string) {
  const url = new URL(`postgresql://openrun_test:${password}@127.0.0.1:${image ? 5432 : port}/${database}`);
  const values = { OPENRUN_TEST_DATABASE_URL: url.href, DATABASE_URL: url.href, WAITING_MIGRATION_DATABASE_URL: "", OPENRUN_SECRETS_FILE: "", SLACK_WEBHOOK_URL: "" };
  const command = image ? "docker" : process.execPath;
  const arguments_ = image ? ["run", "--rm", "--network", `container:${container}`, "--shm-size=1g",
    "--mount", `type=bind,source=${ROOT}/tests,target=/app/tests,readonly`,
    ...Object.entries(values).flatMap(([key, value]) => ["--env", `${key}=${value}`]), image, "node", ...args] : args;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: ROOT, env: { ...process.env, ...values }, stdio: "inherit" });
    child.once("error", () => reject(new Error("Could not start PostgreSQL test suite")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("PostgreSQL test suite failed")));
  });
}
let port = "";
try {
  const started = await exec("docker", ["run", "--rm", "--detach", "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_USER=openrun_test", "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=openrun_test",
    "--mount", "type=tmpfs,destination=/var/lib/postgresql", "postgres:18"], { timeout: 180_000 });
  container = started.stdout.trim();
  const mapped = await exec("docker", ["port", container, "5432/tcp"]);
  port = mapped.stdout.trim().split(":").at(-1)!;
  admin = new Pool({ connectionString: `postgresql://openrun_test:${password}@127.0.0.1:${port}/openrun_test`, connectionTimeoutMillis: 1000 });
  admin.on("error", () => {});
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await admin.query("SELECT 1"); break; }
    catch { if (Date.now() >= deadline) throw new Error("PostgreSQL test container did not become ready"); await delay(100); }
  }
  console.log(JSON.stringify({ status: "POSTGRES_TEST_CONTAINER_READY", runtime: image ? "linux-container" : "host" }));
  await suite(["--test", "tests/postgres/waiting.test.ts"], "openrun_test");
  for (const [database, test] of [["openrun_test_ui", "waiting.e2e.ts"], ["openrun_test_daemon", "waiting-daemon.e2e.ts"]]) {
    // Fixed names in a newly created test-only container, not externally supplied SQL.
    await admin.query(`CREATE DATABASE ${database}`);
    await suite(["src/waiting/migrate.ts"], database);
    await suite([`tests/integration/${test}`], database);
  }
  console.log(JSON.stringify({ status: "POSTGRES_TESTS_PASSED", liveRegistrations: 0 }));
} catch {
  console.error(JSON.stringify({ status: "POSTGRES_TESTS_FAILED" })); process.exitCode = 1;
} finally {
  await admin?.end();
  if (container) await exec("docker", ["stop", "--timeout", "5", container]).catch(() => {});
}
