import { secretsPath } from "../config.ts";
import { decryptJson } from "../sops.ts";
import { loadLocalEnvironment } from "../remote/config.ts";
import { waitingDatabaseUrl, waitingPool, migrateWaitingDatabase } from "./database.ts";
import { AppError } from "../app/store.ts";
import type { Pool } from "pg";

let pool: Pool | undefined;
try {
  loadLocalEnvironment();
  const configured = process.env.WAITING_MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  const values = configured && !process.env.OPENRUN_SECRETS_FILE ? {} : await decryptJson(secretsPath()) as Record<string, unknown>;
  pool = waitingPool(waitingDatabaseUrl(values, true));
  await migrateWaitingDatabase(pool);
  console.log(JSON.stringify({ status: "WAITING_DATABASE_MIGRATED" }));
} catch (error) {
  console.error(JSON.stringify({ status: error instanceof AppError ? error.message : "WAITING_MIGRATION_FAILED" }));
  process.exitCode = 1;
} finally { await pool?.end(); }
