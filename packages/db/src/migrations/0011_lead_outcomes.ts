/**
 * What happened to each delivered lead after it reached the CRM, copied read-only from HubSpot by
 * the sync-outcomes job. One row per lead. Outcomes only: no personal data is stored here.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE lead_outcomes (
      lead_id                 uuid PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
      hubspot_lead_id         text NOT NULL,
      missing                 boolean NOT NULL DEFAULT false,
      lead_stage_id           text,
      lead_stage              text,
      lead_stage_changed_at   timestamptz,
      disqualification_reason text,
      calls_attempted         integer NOT NULL DEFAULT 0,
      calls_connected         integer NOT NULL DEFAULT 0,
      deal_count              integer NOT NULL DEFAULT 0,
      deal_id                 text,
      deal_pipeline           text,
      deal_stage              text,
      deal_created_at         timestamptz,
      proposal_sent_at        timestamptz,
      proposal_status         text,
      lost                    boolean NOT NULL DEFAULT false,
      lost_reason             text,
      sold                    boolean NOT NULL DEFAULT false,
      sold_at                 timestamptz,
      sale_value              numeric(14,2),
      sale_value_field        text CHECK (sale_value_field IN ('total_amount','amount')),
      synced_at               timestamptz NOT NULL DEFAULT now(),
      created_at              timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX lead_outcomes_synced_idx ON lead_outcomes (synced_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS lead_outcomes`.execute(db);
}
