import type { RemoteConfig } from "../remote/config.ts";
import { GrantStore } from "../remote/grants.ts";
import { createRemoteServer } from "../remote/server.ts";
import { sendWaitingNotification } from "../remote/slack.ts";
import { AuthError } from "../errors.ts";
import { WaitingStore } from "./store.ts";
import { WaitingScheduler } from "./scheduler.ts";
import { SyrupWorker } from "./syrup.ts";
import type { SyrupRunner } from "./syrup.ts";

// A waiting deployment has no Catchtable worker, account, desktop or scheduler.
export async function startWaitingService(options: {
  config: RemoteConfig; adminToken: string; databaseFile: string; webhook?: string;
  runner?: SyrupRunner; now?: () => number;
}) {
  const store = new WaitingStore(options.databaseFile, options.adminToken, options.now);
  const scheduler = new WaitingScheduler(store, options.runner ?? new SyrupWorker(), { now: options.now, notify: async job => {
    if (!options.webhook) throw new AuthError("SLACK_NOT_CONFIGURED", "Slack Webhook 설정이 필요합니다.");
    await sendWaitingNotification(options.webhook, job);
  } });
  const server = createRemoteServer({ config: options.config, adminToken: options.adminToken, grants: new GrantStore(), waitingStore: store });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    const closed = new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await scheduler.close(); await closed; store.close();
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.config.port, options.config.host, () => { server.off("error", reject); resolve(); });
    });
    scheduler.start();
  } catch (error) { await stop(); throw error; }
  return { server, store, scheduler, stop };
}
