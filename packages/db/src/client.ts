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
  return new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    ssl:
      cfg.DATABASE_SSL === "disable"
        ? undefined
        : { rejectUnauthorized: cfg.DATABASE_SSL === "require" },
    application_name: "lead-integration-middleware",
    statement_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
  });
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
