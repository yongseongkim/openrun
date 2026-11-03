import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { secretsPath } from "../config.ts";
import { decryptJson, encryptJson } from "../sops.ts";
import { AuthError, publicError } from "../errors.ts";
import { adminToken, remoteConfig, loadLocalEnvironment } from "./config.ts";
import type { LoginRequest } from "./coordinator.ts";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ROOT } from "../config.ts";

try {
  loadLocalEnvironment();
  const command = process.argv[2];
  const path = secretsPath();
  const values = await decryptJson(path) as Record<string, unknown>;
  if (command === "setup") {
    const token = values.OPENRUN_ADMIN_TOKEN;
    if (token !== undefined && token !== "" && (typeof token !== "string" || token.length < 32)) throw new AuthError("INVALID_ADMIN_TOKEN", "OPENRUN_ADMIN_TOKEN은 32자 이상의 임의 문자열이어야 합니다.");
    if (!token) values.OPENRUN_ADMIN_TOKEN = randomBytes(32).toString("base64url");
    values.SLACK_WEBHOOK_URL ??= "";
    await encryptJson(path, values);
    if (process.getuid && process.getgid) {
      const envFile = resolve(ROOT, ".env");
      let local = await readFile(envFile, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
      if (local && !local.endsWith("\n")) local += "\n";
      if (!/^OPENRUN_UID=/m.test(local)) local += `OPENRUN_UID=${process.getuid()}\n`;
      if (!/^OPENRUN_GID=/m.test(local)) local += `OPENRUN_GID=${process.getgid()}\n`;
      await writeFile(envFile, local, { mode: 0o600 });
    }
    console.log(JSON.stringify({ status: "REMOTE_CONFIGURED", message: "기존 계정 정보는 유지했습니다. Slack 알림은 SOPS 파일의 SLACK_WEBHOOK_URL을 설정한 뒤 --notify로 요청합니다." }));
  } else if (command === "console") {
    const config = remoteConfig();
    const response = await fetch(`${config.origin}/api/console/link`, { method: "POST", signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${adminToken(values)}` } });
    if (!response.ok) throw new AuthError("REMOTE_REQUEST_FAILED", "원격 서버 주소와 인증 설정을 확인해 주세요.");
    console.log(JSON.stringify(await response.json()));
  } else if (command === "request") {
    const config = remoteConfig();
    const token = adminToken(values);
    const response = await fetch(`${config.origin}/api/auth/ensure`, {
      method: "POST", signal: AbortSignal.timeout(10_000), headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ notify: process.argv.includes("--notify") }),
    });
    if (!response.ok) throw new AuthError("REMOTE_REQUEST_FAILED", "원격 서버 주소와 인증 설정을 확인해 주세요.");
    const result = await response.json() as { request: LoginRequest; loginUrl: string };
    let job = result.request;
    const until = Date.now() + 75_000;
    while (job.state === "CHECKING" && Date.now() < until) {
      await delay(1000);
      const update = await fetch(`${config.origin}/api/auth/requests/${job.id}`, { signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${token}` } });
      if (!update.ok) throw new AuthError("REMOTE_REQUEST_FAILED", "원격 로그인 상태를 확인하지 못했습니다.");
      job = (await update.json() as { request: LoginRequest }).request;
    }
    // Only this explicit operator command prints a short-lived viewer link.
    // The server never writes viewer links, credentials or cookies to its logs.
    console.log(JSON.stringify({ request: job, ...(job.state === "AUTH_REQUIRED" || job.state === "CHECKING" ? { loginUrl: result.loginUrl } : {}) }));
    if (job.state === "FAILED" || job.state === "EXPIRED") process.exitCode = 1;
  } else throw new AuthError("INVALID_COMMAND", "remote:setup 또는 remote:request를 사용해 주세요.");
} catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
