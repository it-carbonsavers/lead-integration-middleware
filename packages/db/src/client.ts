/**
 * Postgres connection (node-postgres pool) wrapped in a typed Kysely instance.
 * PostgreSQL is mandatory: there is no in-memory fallback.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { Env } from "@lim/config";
import type { Database } from "./schema.js";

// cidr[] (OID 651) and inet[] (OID 1041) are not parsed by default; reuse the text[] parser.
type TypeId = Parameters<typeof pg.types.setTypeParser>[0];
const TEXT_ARRAY = 1009 as TypeId;
const CIDR_ARRAY = 651 as TypeId;
const INET_ARRAY = 1041 as TypeId;
const parseTextArray = pg.types.getTypeParser(TEXT_ARRAY) as (value: string) => string[];
pg.types.setTypeParser(CIDR_ARRAY, parseTextArray);
pg.types.setTypeParser(INET_ARRAY, parseTextArray);

export type DbConfig = Pick<Env, "DATABASE_URL" | "DATABASE_POOL_MAX" | "DATABASE_SSL">;

export function createPool(cfg: DbConfig): pg.Pool {
  const pool = new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    ssl:
      cfg.DATABASE_SSL === "disable"
        ? undefined
        : { rejectUnauthorized: cfg.DATABASE_SSL === "require" },
    application_name: "lead-integration-middleware",
    statement_timeout: 15_000,
    connectionTimeoutMillis: 10_000,
    // Keeps connections through proxies and NAT from being silently dropped.
    keepAlive: true,
  });
  // A connection dropped while idle (network blip, database restart) must not crash the
  // process: the pool discards it and opens a new one on the next query.
  pool.on("error", (err) => {
    console.error(`database: idle connection closed (${err.message})`);
  });
  // The pool only listens for errors on idle connections: it removes its listener while a
  // connection is checked out (Kysely holds one for every query and transaction). A connection
  // whose network drops at that moment emits 'error' with nobody listening, and Node exits.
  // This listener stays on every connection for its whole life. The query that was running still
  // fails normally, and the pool discards the dead connection when it is released.
  pool.on("connect", (client) => {
    client.on("error", (err) => {
      console.error(`database: connection lost while in use (${err.message})`);
    });
  });
  return pool;
}

export function createDb(cfg: DbConfig): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: createPool(cfg) }) });
}

/** Cheap connectivity probe used by readiness checks. */
export async function pingDb(db: Kysely<Database>): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}
