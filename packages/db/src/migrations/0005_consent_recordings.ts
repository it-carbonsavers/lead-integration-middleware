/**
 * Phase 5: consent recordings, SFTP transfer tracking and per-provider SFTP settings.
 *
 *  platform_sftp_configs  how each provider delivers recordings:
 *                           sftp_hosted  provider uploads to our SFTP server (Option A)
 *                           sftp_pull    we pull from the provider's SFTP server (Option B)
 *  transfer_jobs          one row per remote file seen (ledger: a file is never processed twice)
 *  consent_recordings     each stored recording, its checksum, and the lead it belongs to
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE platform_sftp_configs (
      platform_id           uuid PRIMARY KEY REFERENCES platforms(id),
      mode                  text NOT NULL CHECK (mode IN ('sftp_hosted','sftp_pull')),
      -- Option A: account on our SFTP server
      username              text UNIQUE CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9_-]{2,31}$'),
      authorized_keys       text[] NOT NULL DEFAULT '{}',
      -- Option B: provider's SFTP server
      host                  text,
      port                  int CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
      remote_username       text,
      remote_path           text,
      host_key_fingerprint  text,                 -- SHA256:... pinned; connection refused if it changes
      credential_ref        text CHECK (credential_ref IS NULL OR credential_ref ~ '^[A-Za-z0-9._-]{1,100}$'),
      delete_after_pull     boolean NOT NULL DEFAULT false,
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CHECK (mode <> 'sftp_hosted' OR username IS NOT NULL),
      CHECK (mode <> 'sftp_pull' OR (host IS NOT NULL AND remote_username IS NOT NULL AND remote_path IS NOT NULL
                                    AND host_key_fingerprint IS NOT NULL AND credential_ref IS NOT NULL))
    );
    CREATE TRIGGER platform_sftp_configs_updated_at BEFORE UPDATE ON platform_sftp_configs
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE consent_recordings (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id    uuid NOT NULL REFERENCES organisations(id),
      platform_id        uuid NOT NULL REFERENCES platforms(id),
      lead_id            uuid REFERENCES leads(id),
      original_filename  text NOT NULL,
      recording_ref      text NOT NULL,
      storage_key        text UNIQUE,
      content_type       text,
      size_bytes         bigint NOT NULL,
      sha256             bytea NOT NULL,
      status             text NOT NULL CHECK (status IN ('matched','unmatched','rejected','deleted')),
      rejection_reason   text,
      matched_by         text CHECK (matched_by IN ('recording_ref','naming_convention','external_lead_id','admin')),
      matched_at         timestamptz,
      retention_until    timestamptz NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (platform_id, sha256)
    );
    CREATE INDEX consent_recordings_lead_idx ON consent_recordings (lead_id);
    CREATE INDEX consent_recordings_status_idx ON consent_recordings (platform_id, status, created_at DESC);

    CREATE TABLE transfer_jobs (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      platform_id    uuid NOT NULL REFERENCES platforms(id),
      mode           text NOT NULL CHECK (mode IN ('sftp_hosted','sftp_pull')),
      remote_path    text NOT NULL,
      remote_size    bigint NOT NULL,
      remote_mtime   timestamptz NOT NULL,
      recording_id   uuid REFERENCES consent_recordings(id),
      status         text NOT NULL CHECK (status IN ('transferring','stored','rejected','failed','skipped_duplicate')),
      attempts       int NOT NULL DEFAULT 1,
      error_code     text,
      started_at     timestamptz NOT NULL DEFAULT now(),
      finished_at    timestamptz,
      UNIQUE (platform_id, remote_path, remote_size, remote_mtime)
    );
    CREATE INDEX transfer_jobs_platform_idx ON transfer_jobs (platform_id, started_at DESC);

    INSERT INTO role_permissions (role_code, permission)
      VALUES ('provider_viewer', 'recordings.read')
      ON CONFLICT DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM role_permissions WHERE role_code = 'provider_viewer' AND permission = 'recordings.read';
    DROP TABLE IF EXISTS transfer_jobs;
    DROP TABLE IF EXISTS consent_recordings;
    DROP TABLE IF EXISTS platform_sftp_configs;
  `.execute(db);
}
