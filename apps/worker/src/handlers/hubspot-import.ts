/**
 * Adds leads that already exist in HubSpot to a source, so their outcomes are reported.
 *
 * For each active source with a "HubSpot Lead Company" set, every HubSpot Lead (all time) whose
 * lead_company equals it is recorded as a lead of that source with origin 'hubspot_import'.
 * READ-ONLY towards HubSpot, and no personal data is copied: the lead row holds placeholders,
 * the HubSpot ids and the date the lead was created. Leads this system delivered itself (they
 * carry lim_lead_ref) are skipped. Re-running is safe: a lead is only added once.
 *
 * Runs at the start of every outcome sync, so it is off unless OUTCOME_SYNC_ENABLED is true.
 */

import { randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";
import type { Env } from "@lim/config";
import { encrypt, newLeadRef } from "@lim/core";
import type { Database } from "@lim/db";
import { createOutcomeReader, type AdapterDeps } from "@lim/destinations";

export interface ImportDeps {
  db: Kysely<Database>;
  config: Env;
  log: Pick<Logger, "info" | "warn">;
  adapterDeps?: Partial<Omit<AdapterDeps, "db" | "config">>;
}

export interface ImportResult {
  platform: string;
  found: number;
  added: number;
  error?: string;
}

export const IMPORTED_FIRST_NAME = "Imported";
export const IMPORTED_LAST_NAME = "from HubSpot";

export async function importHubSpotLeads(deps: ImportDeps): Promise<ImportResult[]> {
  const { db, config } = deps;
  const sources = await db
    .selectFrom("platforms as p")
    .leftJoin("destinations as own", "own.id", "p.destination_id")
    .leftJoin("destinations as std", (j) => j.on("std.is_default", "=", true))
    .select([
      "p.id",
      "p.code",
      "p.organisation_id",
      "p.hubspot_lead_company",
      sql<string | null>`CASE WHEN own.id IS NOT NULL THEN own.id ELSE std.id END`.as(
        "destinationId",
      ),
    ])
    .where("p.status", "=", "active")
    .where("p.hubspot_lead_company", "is not", null)
    .execute();

  const results: ImportResult[] = [];
  for (const s of sources) {
    const company = s.hubspot_lead_company!;
    try {
      const destination = s.destinationId
        ? await db
            .selectFrom("destinations")
            .selectAll()
            .where("id", "=", s.destinationId)
            .executeTakeFirst()
        : undefined;
      const reader = destination
        ? createOutcomeReader(destination, { config, ...deps.adapterDeps })
        : null;
      if (!destination || !reader) {
        results.push({ platform: s.code, found: 0, added: 0, error: "not_routed_to_hubspot" });
        continue;
      }

      const found = (await reader.findLeadsByCompany(company)).filter((f) => !f.limLeadRef);
      const known = new Set(
        (
          await db
            .selectFrom("leads")
            .select("external_lead_id")
            .where("platform_id", "=", s.id)
            .where("origin", "=", "hubspot_import")
            .execute()
        ).map((r) => r.external_lead_id),
      );
      const fresh = found.filter((f) => !known.has(`HS-${f.hubspotLeadId}`));
      for (const f of fresh) {
        await db
          .insertInto("leads")
          .values({
            lead_ref: newLeadRef(),
            organisation_id: s.organisation_id,
            platform_id: s.id,
            external_lead_id: `HS-${f.hubspotLeadId}`,
            status: "delivered",
            status_changed_at: f.createdAt,
            consent_status: "not_captured",
            first_name: IMPORTED_FIRST_NAME,
            last_name: IMPORTED_LAST_NAME,
            phone_enc: encrypt("", config.APP_ENCRYPTION_KEY),
            phone_bidx: randomBytes(32), // unsearchable placeholder (column is NOT NULL)
            verbal_consent: false,
            transferred_at: f.createdAt,
            received_at: f.createdAt,
            delivered_at: f.createdAt,
            retention_until: new Date(Date.now() + config.LEAD_RETENTION_DAYS * 86_400_000),
            destination_id: destination.id,
            destination_ids: JSON.stringify({
              leadId: f.hubspotLeadId,
              ...(f.contactId ? { contactId: f.contactId } : {}),
            }),
            origin: "hubspot_import",
          })
          .onConflict((oc) => oc.columns(["platform_id", "external_lead_id"]).doNothing())
          .execute();
      }
      results.push({ platform: s.code, found: found.length, added: fresh.length });
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "error";
      results.push({ platform: s.code, found: 0, added: 0, error: code });
      deps.log.warn({ platform: s.code, code }, "HubSpot lead import failed");
    }
  }
  return results;
}
