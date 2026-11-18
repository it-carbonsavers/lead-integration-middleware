/**
 * Phase 3: lead submission, tracking and delivery.
 *
 * Personal data (email, phone, address, notes, extra fields, raw payloads) is stored encrypted
 * (AES-256-GCM, application level). Email and phone also get an HMAC "blind index" so exact-match
 * search and duplicate detection work without decrypting. Names, postcode, state and country stay
 * in clear for admin search and reporting. (Architecture proposal open question Q18: this is the
 * recommended option, adopted as the working assumption.)
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE agents (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      platform_id           uuid NOT NULL REFERENCES platforms(id),
      external_agent_id     text NOT NULL,
      name                  text,
      email                 text,
      destination_owner_id  text,
      active                boolean NOT NULL DEFAULT true,
      first_seen_at         timestamptz NOT NULL DEFAULT now(),
      last_seen_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (platform_id, external_agent_id)
    );
  `.execute(db);

  await sql`
    CREATE TABLE leads (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_ref               text NOT NULL UNIQUE,
      organisation_id        uuid NOT NULL REFERENCES organisations(id),
      platform_id            uuid NOT NULL REFERENCES platforms(id),
      agent_id               uuid REFERENCES agents(id),
      external_lead_id       text NOT NULL,
      status                 text NOT NULL CHECK (status IN (
                               'received','queued','held','discarded','delivering',
                               'retry_scheduled','delivered','failed','dead_letter')),
      status_changed_at      timestamptz NOT NULL DEFAULT now(),
      consent_status         text NOT NULL CHECK (consent_status IN (
                               'not_captured','awaiting_recording','received','matched','unmatched','overdue')),
      possible_duplicate_of  uuid REFERENCES leads(id),
      first_name             text NOT NULL,
      last_name              text NOT NULL,
      email_enc              bytea,
      email_bidx             bytea,
      phone_enc              bytea NOT NULL,
      phone_bidx             bytea NOT NULL,
      address_enc            bytea,
      postcode               text,
      state                  text,
      country                text,
      campaign               text,
      product_interest       text,
      energy_plan            text,
      notes_enc              bytea,
      extra_enc              bytea,
      verbal_consent         boolean NOT NULL,
      consent_captured_at    timestamptz,
      recording_ref          text,
      transferred_at         timestamptz NOT NULL,
      received_at            timestamptz NOT NULL DEFAULT now(),
      delivered_at           timestamptz,
      destination_id         uuid REFERENCES destinations(id),
      destination_ids        jsonb NOT NULL DEFAULT '{}'::jsonb,
      attempt_count          int NOT NULL DEFAULT 0,
      last_error_code        text,
      retention_until        timestamptz NOT NULL,
      UNIQUE (platform_id, external_lead_id)
    );
    CREATE INDEX leads_org_received_idx ON leads (organisation_id, received_at DESC);
    CREATE INDEX leads_platform_transferred_idx ON leads (platform_id, transferred_at);
    CREATE INDEX leads_agent_transferred_idx ON leads (agent_id, transferred_at);
    CREATE INDEX leads_open_status_idx ON leads (status) WHERE status NOT IN ('delivered','discarded');
    CREATE INDEX leads_phone_bidx_idx ON leads (phone_bidx, received_at);
    CREATE INDEX leads_email_bidx_idx ON leads (email_bidx, received_at) WHERE email_bidx IS NOT NULL;
    CREATE INDEX leads_recording_ref_idx ON leads (platform_id, recording_ref) WHERE recording_ref IS NOT NULL;
    CREATE INDEX leads_retention_idx ON leads (retention_until);
  `.execute(db);

  await sql`
    CREATE TABLE submissions (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      platform_id      uuid NOT NULL REFERENCES platforms(id),
      credential_id    uuid REFERENCES platform_api_credentials(id),
      lead_id          uuid REFERENCES leads(id),
      external_lead_id text,
      idempotency_key  text,
      request_id       text NOT NULL,
      source_ip        inet,
      outcome          text NOT NULL CHECK (outcome IN ('accepted','duplicate','rejected')),
      http_status      int NOT NULL,
      error_summary    jsonb,
      payload_enc      bytea,
      received_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX submissions_idempotency_key ON submissions (platform_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND outcome = 'accepted';
    CREATE INDEX submissions_platform_received_idx ON submissions (platform_id, received_at DESC);
    CREATE INDEX submissions_lead_idx ON submissions (lead_id);
  `.execute(db);

  await sql`
    CREATE TABLE delivery_attempts (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id         uuid NOT NULL REFERENCES leads(id),
      destination_id  uuid NOT NULL REFERENCES destinations(id),
      attempt_no      int NOT NULL,
      job_id          text,
      status          text NOT NULL CHECK (status IN ('in_progress','success','retryable_error','permanent_error')),
      step_results    jsonb NOT NULL DEFAULT '{}'::jsonb,
      http_status     int,
      error_code      text,
      error_message   text,
      started_at      timestamptz NOT NULL DEFAULT now(),
      finished_at     timestamptz,
      UNIQUE (lead_id, attempt_no)
    );

    CREATE TABLE lead_events (
      id           bigserial PRIMARY KEY,
      lead_id      uuid NOT NULL REFERENCES leads(id),
      type         text NOT NULL,
      from_status  text,
      to_status    text,
      actor_type   text NOT NULL CHECK (actor_type IN ('system','platform','admin')),
      actor_id     uuid,
      detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX lead_events_lead_idx ON lead_events (lead_id, id);

    -- What the local mock destination "received". Lets reviewers see exactly what would have been
    -- sent to a CRM, without sending anything anywhere. Holds the outbound payload in encrypted form.
    CREATE TABLE mock_destination_records (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      destination_id  uuid NOT NULL REFERENCES destinations(id),
      lead_ref        text NOT NULL UNIQUE,
      contact_key     text NOT NULL,
      payload_enc     bytea NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS mock_destination_records;
    DROP TABLE IF EXISTS lead_events;
    DROP TABLE IF EXISTS delivery_attempts;
    DROP TABLE IF EXISTS submissions;
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS agents;
  `.execute(db);
}
