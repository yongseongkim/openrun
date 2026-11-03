import { credentialsFrom } from "../credentials.ts";
import { secretsPath } from "../config.ts";
import { decryptJson } from "../sops.ts";
import { AuthError, publicError } from "../errors.ts";
import { adminToken, remoteConfig, loadLocalEnvironment } from "./config.ts";
import { GrantStore } from "./grants.ts";
import { PersistentAuthWorker } from "./worker.ts";
import { AuthCoordinator } from "./coordinator.ts";
import { createRemoteServer, loginLink } from "./server.ts";
import { sendLoginNotification, sendBookingNotification } from "./slack.ts";
import { AppStore } from "../app/store.ts";
import { BookingScheduler } from "../app/scheduler.ts";
import { resolve } from "node:path";
import { ROOT } from "../config.ts";

try {
  loadLocalEnvironment();
  const config = remoteConfig();
  const values = await decryptJson(secretsPath()) as Record<string, unknown>;
  let credentials;
  try { credentials = credentialsFrom(values, config.provider); }
  catch (error) { if (!(error instanceof AuthError) || error.code !== "CREDENTIALS_MISSING") throw error; }
  const grants = new GrantStore();
  const worker = new PersistentAuthWorker(config, credentials);
  const webhook = process.env.SLACK_WEBHOOK_URL ?? values.SLACK_WEBHOOK_URL;
  const coordinator = new AuthCoordinator(worker, config.ttlMs, typeof webhook === "string" && webhook ? async (job) => {
    await sendLoginNotification(webhook, loginLink(config.origin, grants, job), job.expiresAt);
  } : undefined);
  const store = new AppStore(resolve(process.env.OPENRUN_DATA_DIR ?? resolve(ROOT, ".runtime"), "openrun.sqlite"));
  store.seed();
  const scheduler = new BookingScheduler(store, coordinator, { ready: async (job, request) => {
    if (!job.notify) return;
    if (typeof webhook !== "string" || !webhook) throw new AuthError("SLACK_NOT_CONFIGURED", "Slack Webhook 설정이 필요합니다.");
    await sendBookingNotification(webhook, store.restaurant(job.restaurantId).name, `${job.diningDate} ${job.diningTime} · ${job.partySize}명`, loginLink(config.origin, grants, request));
  } });
  const server = createRemoteServer({ config, grants, coordinator, store, adminToken: adminToken(values) });
  scheduler.start();
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ status: "REMOTE_READY", origin: config.origin, provider: config.provider })));
  server.on("error", () => { console.error(JSON.stringify({ status: "SERVER_START_FAILED" })); process.exitCode = 1; });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close(); server.closeAllConnections();
    await scheduler.close();
    await coordinator.close();
    store.close();
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
} catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
