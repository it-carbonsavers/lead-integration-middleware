/**
 * lead_deals: every HubSpot deal credited to a lead (linked to the lead, or to its contact and
 * created after the lead arrived), so a lead with several deals reports all of them. Written by
 * the sync-outcomes job. Deal facts only: no personal data is stored here.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE lead_deals (
      lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      deal_id          text NOT NULL,
      linked           boolean NOT NULL DEFAULT false,
      pipeline         text,
      stage            text,
      deal_created_at  timestamptz,
      proposal_sent_at timestamptz,
      lost             boolean NOT NULL DEFAULT false,
      sold             boolean NOT NULL DEFAULT false,
      sold_at          timestamptz,
      sale_value       numeric(14,2),
      quote_value      numeric(14,2),
      synced_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (lead_id, deal_id)
    );
    CREATE INDEX lead_deals_deal_id_idx ON lead_deals (deal_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS lead_deals;`.execute(db);
}
