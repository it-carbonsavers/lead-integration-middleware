/**
 * Consent recordings arrive only by upload to OUR SFTP server (Option A, decided 17 Nov 2026).
 * The "we collect from the provider's server" option (sftp_pull) is removed:
 *  - existing pull configurations are deleted and those sources set to "none"
 *  - pull-only columns (their host, credential, host key, folder) are dropped
 *  - mode can only be sftp_hosted; transfer history keeps its original mode values
 * Adds account_synced_at: when the provider's account was last pushed to the SFTP server
 * (SFTPGo); NULL when the server reads accounts from our database (local dev server).
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM platform_sftp_configs WHERE mode = 'sftp_pull';
    UPDATE platforms SET recording_ingest_mode = 'none' WHERE recording_ingest_mode = 'sftp_pull';

    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'platform_sftp_configs'::regclass AND contype = 'c'
                 AND pg_get_constraintdef(oid) LIKE '%sftp_pull%'
      LOOP
        EXECUTE format('ALTER TABLE platform_sftp_configs DROP CONSTRAINT %I', c);
      END LOOP;
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'platforms'::regclass AND contype = 'c'
                 AND pg_get_constraintdef(oid) LIKE '%recording_ingest_mode%'
      LOOP
        EXECUTE format('ALTER TABLE platforms DROP CONSTRAINT %I', c);
      END LOOP;
    END $$;

    ALTER TABLE platform_sftp_configs
      DROP COLUMN host,
      DROP COLUMN port,
      DROP COLUMN remote_username,
      DROP COLUMN remote_path,
      DROP COLUMN host_key_fingerprint,
      DROP COLUMN credential_ref,
      DROP COLUMN credential_enc,
      DROP COLUMN delete_after_pull,
      DROP CONSTRAINT IF EXISTS platform_sftp_hosted_auth,
      ADD COLUMN account_synced_at timestamptz,
      ADD CONSTRAINT platform_sftp_hosted_only CHECK (mode = 'sftp_hosted'),
      ADD CONSTRAINT platform_sftp_hosted_auth CHECK (auth_method = 'key' OR password_hash IS NOT NULL),
      ALTER COLUMN username SET NOT NULL;

    ALTER TABLE platforms
      ADD CONSTRAINT platforms_recording_ingest_mode_check
        CHECK (recording_ingest_mode IN ('none','sftp_hosted'));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE platforms DROP CONSTRAINT IF EXISTS platforms_recording_ingest_mode_check;
    ALTER TABLE platforms ADD CONSTRAINT platforms_recording_ingest_mode_check
      CHECK (recording_ingest_mode IN ('none','sftp_hosted','sftp_pull'));
    ALTER TABLE platform_sftp_configs
      DROP CONSTRAINT IF EXISTS platform_sftp_hosted_only,
      DROP CONSTRAINT IF EXISTS platform_sftp_hosted_auth,
      ALTER COLUMN username DROP NOT NULL,
      DROP COLUMN IF EXISTS account_synced_at,
      ADD COLUMN host text,
      ADD COLUMN port int,
      ADD COLUMN remote_username text,
      ADD COLUMN remote_path text,
      ADD COLUMN host_key_fingerprint text,
      ADD COLUMN credential_ref text,
      ADD COLUMN credential_enc bytea,
      ADD COLUMN delete_after_pull boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT platform_sftp_configs_mode_check CHECK (mode IN ('sftp_hosted','sftp_pull')),
      ADD CONSTRAINT platform_sftp_hosted_auth CHECK (
        mode <> 'sftp_hosted' OR auth_method = 'key' OR password_hash IS NOT NULL);
  `.execute(db);
}
