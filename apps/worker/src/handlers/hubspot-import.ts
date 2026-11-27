/**
 * Adds leads that already exist in HubSpot to a source, so their outcomes are reported.
 *
 * For each active source with a "HubSpot Lead Company" set, every HubSpot Lead (all time) whose
 * lead_company equals it is recorded as a lead of that source with origin 'hubspot_import'.
 * The first run reads them all; later runs read only leads created since the newest imported one.
 * READ-ONLY towards HubSpot. The lead's HubSpot contact details (name, phone, email, address) are
 * copied once and stored encrypted like any other lead. Only leads still without them are read on
 * each run, so a run stays quick however many leads the source has. Leads this system delivered itself (they carry lim_lead_ref) are
 * skipped. Re-running is safe: a lead is only added once.
 *
 * Runs at the start of every outcome sync, so it is off unless OUTCOME_SYNC_ENABLED is true.
 */

import { randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";
import type { Env } from "@lim/config";
import { encrypt, newLeadRef, toE164 } from "@lim/core";
import { emailIndex, phoneIndex, type Database } from "@lim/db";
import {
  createOutcomeReader,
  type AdapterDeps,
  type ContactDetails,
  type HubSpotOutcomeReader,
} from "@lim/destinations";

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
  /** Imported leads whose contact details were refreshed from HubSpot. */
  detailsUpdated?: number;
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

      // After the first import, only read leads created since the newest one already imported
      // (with a day of overlap), so each run stays small however many leads the source has.
      const newest = await db
        .selectFrom("leads")
        .select((eb) => eb.fn.max("received_at").as("at"))
        .where("platform_id", "=", s.id)
        .where("origin", "=", "hubspot_import")
        .executeTakeFirst();
      const since = newest?.at ? new Date(new Date(newest.at).getTime() - 86_400_000) : undefined;
      const found = (await reader.findLeadsByCompany(company, since)).filter((f) => !f.limLeadRef);
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
      const detailsUpdated = await refreshContactDetails(db, config, reader, s.id);
      results.push({ platform: s.code, found: found.length, added: fresh.length, detailsUpdated });
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "error";
      results.push({ platform: s.code, found: 0, added: 0, error: code });
      deps.log.warn({ platform: s.code, code }, "HubSpot lead import failed");
    }
  }
  return results;
}

/**
 * Copies HubSpot contact details into imported leads that do not have them yet (they still carry
 * the placeholder name), encrypted like API leads. Leads anonymised by retention are left alone.
 */
async function refreshContactDetails(
  db: Kysely<Database>,
  config: Env,
  reader: HubSpotOutcomeReader,
  platformId: string,
): Promise<number> {
  const rows = await db
    .selectFrom("leads")
    .select(["id", sql<string | null>`destination_ids->>'contactId'`.as("contactId")])
    .where("platform_id", "=", platformId)
    .where("origin", "=", "hubspot_import")
    .where("anonymised_at", "is", null)
    .where("first_name", "=", IMPORTED_FIRST_NAME)
    .where("last_name", "=", IMPORTED_LAST_NAME)
    .execute();
  const withContact = rows.filter((r): r is { id: string; contactId: string } => !!r.contactId);
  if (withContact.length === 0) return 0;
  const contacts = await reader.readContacts(withContact.map((r) => r.contactId));
  const keys = {
    encryptionKey: config.APP_ENCRYPTION_KEY,
    blindIndexKey: config.APP_BLIND_INDEX_KEY,
  };
  let updated = 0;
  for (const r of withContact) {
    const c = contacts.get(r.contactId);
    if (!c) continue;
    await db
      .updateTable("leads")
      .set(contactColumns(c, config, keys))
      .where("id", "=", r.id)
      .execute();
    updated++;
  }
  return updated;
}

const clip = (v: string | null, max: number) => (v ? v.trim().slice(0, max) || null : null);

/** HubSpot stores country as free text; keep an ISO code when it is one we can tell. */
function countryCode(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  if (/^australia$/i.test(t)) return "AU";
  if (/^new zealand$/i.test(t)) return "NZ";
  return null;
}

function contactColumns(
  c: ContactDetails,
  config: Env,
  keys: { encryptionKey: string; blindIndexKey: string },
) {
  const country = countryCode(c.country);
  const e164 = toE164(c.phone, country ?? config.DEFAULT_PHONE_REGION);
  const phone = e164 ?? clip(c.phone, 32) ?? "";
  const email =
    c.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email) ? c.email.trim().toLowerCase() : null;
  const address =
    c.address || c.city || c.state || c.postcode
      ? {
          line1: clip(c.address, 200) ?? "",
          ...(c.city ? { city: clip(c.city, 100) } : {}),
          ...(c.state ? { state: clip(c.state, 50) } : {}),
          ...(c.postcode ? { postcode: clip(c.postcode, 10) } : {}),
          ...(country ? { country } : {}),
        }
      : null;
  return {
    first_name: clip(c.firstName, 100) ?? IMPORTED_FIRST_NAME,
    last_name: clip(c.lastName, 100) ?? (c.firstName ? "" : IMPORTED_LAST_NAME),
    phone_enc: encrypt(phone, keys.encryptionKey),
    // Searchable only when the number is valid (same index as API leads, so duplicates show).
    phone_bidx: e164 ? phoneIndex(e164, keys) : randomBytes(32),
    email_enc: email ? encrypt(email, keys.encryptionKey) : null,
    email_bidx: email ? emailIndex(email, keys) : null,
    address_enc: address ? encrypt(JSON.stringify(address), keys.encryptionKey) : null,
    postcode: clip(c.postcode, 10),
    state: clip(c.state, 50),
    country,
  };
}
