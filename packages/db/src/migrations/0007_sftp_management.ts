/**
 * SFTP management per lead source:
 *  - authentication method (SSH key or password) for both options
 *  - Option A password: stored only as an argon2id hash (we generate it and show it once)
 *  - Option B credential (provider's password or our private key for their server): stored
 *    AES-256-GCM encrypted in the database, write-only through the dashboard
 *  - connection status: last check, last success, last error, last file received
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE platform_sftp_configs
      ADD COLUMN auth_method      text NOT NULL DEFAULT 'key' CHECK (auth_method IN ('key','password')),
      ADD COLUMN password_hash    text,
      ADD COLUMN credential_enc   bytea,
      ADD COLUMN last_checked_at  timestamptz,
      ADD COLUMN last_success_at  timestamptz,
      ADD COLUMN last_error       text,
      ADD COLUMN last_file_at     timestamptz;

    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'platform_sftp_configs'::regclass AND contype = 'c'
                 AND pg_get_constraintdef(oid) LIKE '%sftp_pull%'
      LOOP
        EXECUTE format('ALTER TABLE platform_sftp_configs DROP CONSTRAINT %I', c);
      END LOOP;
    END $$;

    ALTER TABLE platform_sftp_configs
      ADD CONSTRAINT platform_sftp_pull_complete CHECK (
        mode <> 'sftp_pull' OR (host IS NOT NULL AND remote_username IS NOT NULL AND remote_path IS NOT NULL
                                AND host_key_fingerprint IS NOT NULL
                                AND (credential_enc IS NOT NULL OR credential_ref IS NOT NULL))),
      ADD CONSTRAINT platform_sftp_hosted_auth CHECK (
        mode <> 'sftp_hosted' OR auth_method = 'key' OR password_hash IS NOT NULL);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE platform_sftp_configs
      DROP CONSTRAINT IF EXISTS platform_sftp_hosted_auth,
      DROP CONSTRAINT IF EXISTS platform_sftp_pull_complete,
      DROP COLUMN IF EXISTS last_file_at,
      DROP COLUMN IF EXISTS last_error,
      DROP COLUMN IF EXISTS last_success_at,
      DROP COLUMN IF EXISTS last_checked_at,
      DROP COLUMN IF EXISTS credential_enc,
      DROP COLUMN IF EXISTS password_hash,
      DROP COLUMN IF EXISTS auth_method;
    ALTER TABLE platform_sftp_configs ADD CONSTRAINT platform_sftp_configs_check1 CHECK (
      mode <> 'sftp_pull' OR (host IS NOT NULL AND remote_username IS NOT NULL AND remote_path IS NOT NULL
                              AND host_key_fingerprint IS NOT NULL AND credential_ref IS NOT NULL));
  `.execute(db);
}
