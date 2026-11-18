/**
 * Phase 4: admin sign-in hardening (lockout) and session bookkeeping.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE admin_users
      ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
      ADD COLUMN locked_until timestamptz,
      ADD COLUMN password_changed_at timestamptz;
    CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS admin_sessions_expires_idx;
    ALTER TABLE admin_users
      DROP COLUMN IF EXISTS failed_login_count,
      DROP COLUMN IF EXISTS locked_until,
      DROP COLUMN IF EXISTS password_changed_at;
  `.execute(db);
}
