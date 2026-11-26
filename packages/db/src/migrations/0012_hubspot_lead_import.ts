/**
 * Existing HubSpot leads for a source, for performance reporting.
 *  - platforms.hubspot_lead_company: when set, leads already in HubSpot whose "Lead Company" equals
 *    this value are imported into the source (read-only, no personal data copied)
 *  - leads.origin: 'api' (sent by the provider) or 'hubspot_import' (read from HubSpot)
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE platforms ADD COLUMN hubspot_lead_company text;
    ALTER TABLE leads ADD COLUMN origin text NOT NULL DEFAULT 'api'
      CHECK (origin IN ('api','hubspot_import'));
    CREATE INDEX leads_platform_origin_idx ON leads (platform_id, origin);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS leads_platform_origin_idx;
    ALTER TABLE leads DROP COLUMN IF EXISTS origin;
    ALTER TABLE platforms DROP COLUMN IF EXISTS hubspot_lead_company;
  `.execute(db);
}
