import { resolve } from "node:path";
import { ROOT, secretsPath } from "../config.ts";
import { decryptJson } from "../sops.ts";
import { publicError } from "../errors.ts";
import { adminToken, loadLocalEnvironment, remoteConfig } from "../remote/config.ts";
import { startWaitingService } from "./service.ts";

try {
  loadLocalEnvironment();
  // SOPS/GCP KMS remains supported; isolated tests can supply a disposable key.
  const values = process.env.OPENRUN_ADMIN_TOKEN && !process.env.OPENRUN_SECRETS_FILE
    ? {} : await decryptJson(secretsPath()) as Record<string, unknown>;
  const config = remoteConfig();
  const webhook = process.env.SLACK_WEBHOOK_URL ?? values.SLACK_WEBHOOK_URL;
  const service = await startWaitingService({
    config, adminToken: adminToken(values),
    databaseFile: resolve(process.env.OPENRUN_DATA_DIR ?? resolve(ROOT, ".runtime"), "openrun.sqlite"),
    webhook: typeof webhook === "string" ? webhook : undefined,
  });
  console.log(JSON.stringify({ status: "WAITING_READY", origin: config.origin, timezone: "Asia/Seoul" }));
  const stop = () => { void service.stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  service.server.on("error", () => { console.error(JSON.stringify({ status: "SERVER_FAILED" })); process.exitCode = 1; stop(); });
} catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
