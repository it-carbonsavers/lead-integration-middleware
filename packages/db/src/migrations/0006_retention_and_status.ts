/**
 * Phase 6: lead anonymisation marker and a small service-status table (worker heartbeat,
 * last SFTP scan) shown on the admin System status page.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE leads ADD COLUMN anonymised_at timestamptz;
    CREATE TABLE service_status (
      name          text PRIMARY KEY,
      last_seen_at  timestamptz NOT NULL DEFAULT now(),
      detail        jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS service_status;
    ALTER TABLE leads DROP COLUMN IF EXISTS anonymised_at;
  `.execute(db);
}
