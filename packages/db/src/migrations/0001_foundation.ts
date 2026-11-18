/**
 * Phase 2 foundation schema.
 *
 * Tenancy, admin users/roles, destinations, source platforms, platform API credentials,
 * audit log (append-only) and retention policy table.
 *
 * Deliberately NOT here yet (they depend on open questions and land with their phase):
 *   P3  leads, submissions, delivery_attempts, lead_events, agents, platform_field_mappings
 *   P5  consent_recordings, transfer_jobs, platform_sftp_configs
 */

import { sql, type Kysely } from "kysely";
import { ROLES } from "@lim/core";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END $$;
  `.execute(db);

  // --- Tenancy -------------------------------------------------------------
  await sql`
    CREATE TABLE organisations (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
      status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER organisations_updated_at BEFORE UPDATE ON organisations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `.execute(db);

  // --- Admin users, roles, sessions ----------------------------------------
  await sql`
    CREATE TABLE admin_users (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id  uuid REFERENCES organisations(id),
      email            text NOT NULL,
      name             text,
      auth_provider    text NOT NULL CHECK (auth_provider IN ('oidc','local')),
      oidc_subject     text UNIQUE,
      password_hash    text,
      mfa_secret_enc   bytea,
      status           text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
      last_login_at    timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CHECK (auth_provider <> 'local' OR oidc_subject IS NULL),
      CHECK (auth_provider <> 'oidc' OR password_hash IS NULL)
    );
    CREATE UNIQUE INDEX admin_users_email_key ON admin_users (lower(email));
    CREATE TRIGGER admin_users_updated_at BEFORE UPDATE ON admin_users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE roles (
      code         text PRIMARY KEY,
      description  text NOT NULL
    );
    CREATE TABLE role_permissions (
      role_code   text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
      permission  text NOT NULL,
      PRIMARY KEY (role_code, permission)
    );
    CREATE TABLE admin_user_roles (
      user_id    uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      role_code  text NOT NULL REFERENCES roles(code),
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role_code)
    );
    CREATE TABLE admin_sessions (
      id_hash     bytea PRIMARY KEY,
      user_id     uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      created_at  timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      ip          inet,
      user_agent  text
    );
    CREATE INDEX admin_sessions_user_idx ON admin_sessions (user_id);
  `.execute(db);

  for (const [code, role] of Object.entries(ROLES)) {
    await sql`INSERT INTO roles (code, description) VALUES (${code}, ${role.description})`.execute(
      db,
    );
    for (const permission of role.permissions) {
      await sql`INSERT INTO role_permissions (role_code, permission) VALUES (${code}, ${permission})`.execute(
        db,
      );
    }
  }

  // --- Destinations --------------------------------------------------------
  await sql`
    CREATE TABLE destinations (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type            text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]{1,31}$'),
      name            text NOT NULL,
      is_default      boolean NOT NULL DEFAULT false,
      config          jsonb NOT NULL DEFAULT '{}'::jsonb,
      credential_ref  text NOT NULL CHECK (credential_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX destinations_one_default ON destinations ((true)) WHERE is_default;
    CREATE TRIGGER destinations_updated_at BEFORE UPDATE ON destinations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `.execute(db);

  // --- Source platforms (lead providers) -----------------------------------
  await sql`
    CREATE TABLE platforms (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organisation_id        uuid NOT NULL REFERENCES organisations(id),
      code                   text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{2,15}$'),
      display_name           text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
      status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      require_hmac           boolean NOT NULL DEFAULT false,
      allowed_cidrs          cidr[] NOT NULL DEFAULT '{}',
      rate_limit_per_min     int CHECK (rate_limit_per_min IS NULL OR rate_limit_per_min BETWEEN 1 AND 100000),
      recording_ingest_mode  text NOT NULL DEFAULT 'none'
                             CHECK (recording_ingest_mode IN ('none','sftp_hosted','sftp_pull')),
      destination_id         uuid REFERENCES destinations(id),
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX platforms_org_idx ON platforms (organisation_id);
    CREATE TRIGGER platforms_updated_at BEFORE UPDATE ON platforms
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE platform_api_credentials (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      platform_id      uuid NOT NULL REFERENCES platforms(id),
      env_tag          text NOT NULL CHECK (env_tag IN ('live','stg','dev','test')),
      key_prefix       text NOT NULL UNIQUE CHECK (key_prefix ~ '^[0-9A-Za-z]{8}$'),
      key_hash         bytea NOT NULL CHECK (octet_length(key_hash) = 32),
      hmac_secret_enc  bytea,
      label            text,
      last_used_at     timestamptz,
      expires_at       timestamptz,
      revoked_at       timestamptz,
      created_by       uuid REFERENCES admin_users(id),
      created_at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX platform_api_credentials_platform_idx ON platform_api_credentials (platform_id);
  `.execute(db);

  // --- Audit log (append-only) ---------------------------------------------
  await sql`
    CREATE TABLE audit_log (
      id               bigserial PRIMARY KEY,
      occurred_at      timestamptz NOT NULL DEFAULT now(),
      actor_type       text NOT NULL CHECK (actor_type IN ('admin','platform','system')),
      actor_id         uuid,
      actor_label      text,
      organisation_id  uuid,
      action           text NOT NULL,
      target_type      text,
      target_id        text,
      request_id       text,
      ip               inet,
      detail           jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at DESC);
    CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);
    CREATE INDEX audit_log_actor_idx ON audit_log (actor_type, actor_id);

    -- Rows can only be inserted. Updates, deletes and truncation are refused unless the
    -- transaction has explicitly opted in (SET LOCAL lim.audit_purge = 'on'), which only the
    -- retention job does, and that purge is itself audited.
    CREATE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND coalesce(current_setting('lim.audit_purge', true), '') = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END $$;
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
    CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();
  `.execute(db);

  // --- Retention policies (values agreed with client, open question Q16) ----
  await sql`
    CREATE TABLE retention_policies (
      entity      text PRIMARY KEY,
      keep_days   int NOT NULL CHECK (keep_days > 0),
      action      text NOT NULL CHECK (action IN ('delete','anonymise')),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER retention_policies_updated_at BEFORE UPDATE ON retention_policies
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS retention_policies;
    DROP TABLE IF EXISTS audit_log;
    DROP FUNCTION IF EXISTS audit_log_guard();
    DROP TABLE IF EXISTS platform_api_credentials;
    DROP TABLE IF EXISTS platforms;
    DROP TABLE IF EXISTS destinations;
    DROP TABLE IF EXISTS admin_sessions;
    DROP TABLE IF EXISTS admin_user_roles;
    DROP TABLE IF EXISTS role_permissions;
    DROP TABLE IF EXISTS roles;
    DROP TABLE IF EXISTS admin_users;
    DROP TABLE IF EXISTS organisations;
    DROP FUNCTION IF EXISTS set_updated_at();
  `.execute(db);
}
