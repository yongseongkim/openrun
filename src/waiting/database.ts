import { Pool } from "pg";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { AppError } from "../app/store.ts";

export function waitingDatabaseUrl(values: Record<string, unknown> = {}, migration = false): string {
  const value = (migration ? process.env.WAITING_MIGRATION_DATABASE_URL || values.WAITING_MIGRATION_DATABASE_URL : undefined)
    || process.env.DATABASE_URL || values.DATABASE_URL;
  if (typeof value !== "string" || !value) throw new AppError("WAITING_DATABASE_REQUIRED", 500);
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error();
  } catch { throw new AppError("INVALID_DATABASE_URL", 500); }
  return value;
}
export function waitingPool(connectionString: string): Pool {
  // Never interpolate a URL, password, query, or driver error into logs.
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, query_timeout: 10_000,
    statement_timeout: 10_000, idle_in_transaction_session_timeout: 15_000, application_name: "openrun-waiting" });
  // Checked-out clients also need an error listener; queries surface safe errors.
  pool.on("connect", client => { client.on("error", () => {}); });
  pool.on("error", () => { console.error(JSON.stringify({ status: "WAITING_DATABASE_CONNECTION_LOST" })); });
  return pool;
}
export function databaseFailure(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError("WAITING_DATABASE_UNAVAILABLE", 503);
}
export async function waitingMigrations() {
  const directory = new URL("./migrations/", import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  return Promise.all(files.map(async name => {
    const sql = await readFile(new URL(name, directory), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}
export async function migrateWaitingDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect().catch(error => { throw databaseFailure(error); });
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1,$2)", [0x4f50454e, 0x4d494752]);
    await client.query("CREATE TABLE IF NOT EXISTS waiting_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const migration of await waitingMigrations()) {
      const previous = await client.query("SELECT checksum FROM waiting_schema_migrations WHERE name=$1", [migration.name]);
      if (previous.rowCount) {
        if (previous.rows[0].checksum !== migration.checksum) throw new AppError("WAITING_MIGRATION_CHANGED", 500);
        continue;
      }
      await client.query(migration.sql);
      await client.query("INSERT INTO waiting_schema_migrations(name,checksum) VALUES($1,$2)", [migration.name, migration.checksum]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw databaseFailure(error); }
  finally { client.release(); }
}
