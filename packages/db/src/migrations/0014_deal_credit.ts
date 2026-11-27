/**
 * lead_outcomes.deal_linked: true when the credited deal is linked to the lead itself in HubSpot
 * (not only to the lead's contact). When several leads share one deal, the reports credit it to
 * the linked lead, else to the earliest lead received.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE lead_outcomes ADD COLUMN deal_linked boolean NOT NULL DEFAULT false;`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS lead_outcomes_deal_id_idx ON lead_outcomes (deal_id) WHERE deal_id IS NOT NULL;`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS lead_outcomes_deal_id_idx;`.execute(db);
  await sql`ALTER TABLE lead_outcomes DROP COLUMN IF EXISTS deal_linked;`.execute(db);
}
