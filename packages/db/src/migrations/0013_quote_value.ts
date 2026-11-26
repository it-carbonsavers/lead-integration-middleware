/**
 * lead_outcomes.quote_value: the credited deal's quote total (total_amount, else amount), kept
 * whether or not the deal is sold, so open and lost proposals show what was quoted.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE lead_outcomes ADD COLUMN quote_value numeric(14,2);`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE lead_outcomes DROP COLUMN IF EXISTS quote_value;`.execute(db);
}
