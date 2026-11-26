/**
 * Versioned migrations using Kysely's Migrator with a static provider: every migration is
 * imported explicitly, so the same list works from TypeScript sources and compiled dist/.
 * Add new migrations to the map below in order; never edit one that has been applied anywhere.
 */

import type { Kysely } from "kysely";
import { Migrator, type Migration, type MigrationResult } from "kysely/migration";
import * as m0001 from "./migrations/0001_foundation.js";
import * as m0002 from "./migrations/0002_leads.js";
import * as m0003 from "./migrations/0003_admin_auth.js";
import * as m0004 from "./migrations/0004_provider_users.js";
import * as m0005 from "./migrations/0005_consent_recordings.js";
import * as m0006 from "./migrations/0006_retention_and_status.js";
import * as m0007 from "./migrations/0007_sftp_management.js";
import * as m0008 from "./migrations/0008_hosted_sftp_only.js";
import * as m0009 from "./migrations/0009_portal_upload.js";
import * as m0010 from "./migrations/0010_upload_lead_choice.js";
import * as m0011 from "./migrations/0011_lead_outcomes.js";
import * as m0012 from "./migrations/0012_hubspot_lead_import.js";
import * as m0013 from "./migrations/0013_quote_value.js";

export const MIGRATIONS: Record<string, Migration> = {
  "0001_foundation": m0001,
  "0002_leads": m0002,
  "0003_admin_auth": m0003,
  "0004_provider_users": m0004,
  "0005_consent_recordings": m0005,
  "0006_retention_and_status": m0006,
  "0007_sftp_management": m0007,
  "0008_hosted_sftp_only": m0008,
  "0009_portal_upload": m0009,
  "0010_upload_lead_choice": m0010,
  "0011_lead_outcomes": m0011,
  "0012_hubspot_lead_import": m0012,
  "0013_quote_value": m0013,
};

const TABLE = "schema_migrations";
const LOCK_TABLE = "schema_migrations_lock";

function migrator(db: Kysely<any>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => MIGRATIONS },
    migrationTableName: TABLE,
    migrationLockTableName: LOCK_TABLE,
  });
}

export interface MigrationRun {
  results: MigrationResult[];
  error?: unknown;
}

export async function migrateToLatest(db: Kysely<any>): Promise<MigrationRun> {
  const { results = [], error } = await migrator(db).migrateToLatest();
  return error === undefined ? { results } : { results, error };
}

export async function migrateDown(db: Kysely<any>): Promise<MigrationRun> {
  const { results = [], error } = await migrator(db).migrateDown();
  return error === undefined ? { results } : { results, error };
}

export async function migrationStatus(
  db: Kysely<any>,
): Promise<{ name: string; executedAt: Date | null }[]> {
  const list = await migrator(db).getMigrations();
  return list.map((m) => ({ name: m.name, executedAt: m.executedAt ?? null }));
}

/** True when every known migration has been applied (used by /health/ready). */
export async function isSchemaCurrent(db: Kysely<any>): Promise<boolean> {
  try {
    const status = await migrationStatus(db);
    return status.every((m) => m.executedAt !== null);
  } catch {
    return false;
  }
}
