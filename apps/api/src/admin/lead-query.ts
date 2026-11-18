/**
 * Shared lead filtering for the admin list, CSV export and report drill-downs, so a number in a
 * report always links to exactly the leads behind it.
 */

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { sql, type ExpressionBuilder, type Kysely, type SelectQueryBuilder } from "kysely";
import { z } from "zod";
import type { Env } from "@lim/config";
import { decrypt } from "@lim/core";
import { emailIndex, phoneIndex, type Database, type LeadStatus } from "@lim/db";
import type { AdminContext } from "./auth.js";

const LEAD_STATUSES = [
  "received",
  "queued",
  "held",
  "discarded",
  "delivering",
  "retry_scheduled",
  "delivered",
  "failed",
  "dead_letter",
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "YYYY-MM-DD" });

export const leadFilterSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  dateField: z.enum(["received_at", "transferred_at"]).default("received_at"),
  platform: z.string().max(16).optional(),
  agent: z.uuid().optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : []))
    .pipe(z.array(z.enum(LEAD_STATUSES))),
  /** Convenience group: failed + dead_letter */
  problem: z.enum(["true", "false"]).optional(),
  consent: z
    .enum(["not_captured", "awaiting_recording", "received", "matched", "unmatched", "overdue"])
    .optional(),
  duplicate: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(200).optional(),
});
export type LeadFilter = z.infer<typeof leadFilterSchema>;

type LeadQB = SelectQueryBuilder<Database, "leads" | "platforms", object>;

/** Start of `date` in the report time zone, as timestamptz. */
export const dayStart = (date: string, tz: string) =>
  sql<Date>`(${date}::date)::timestamp AT TIME ZONE ${tz}`;
export const dayEnd = (date: string, tz: string) =>
  sql<Date>`((${date}::date + 1))::timestamp AT TIME ZONE ${tz}`;

export function applyLeadFilters(
  qb: LeadQB,
  f: LeadFilter,
  config: Pick<
    Env,
    "REPORT_TIMEZONE" | "APP_ENCRYPTION_KEY" | "APP_BLIND_INDEX_KEY" | "DEFAULT_PHONE_REGION"
  >,
): LeadQB {
  const tz = config.REPORT_TIMEZONE;
  const keys = {
    encryptionKey: config.APP_ENCRYPTION_KEY,
    blindIndexKey: config.APP_BLIND_INDEX_KEY,
  };
  const col = f.dateField === "transferred_at" ? "leads.transferred_at" : "leads.received_at";
  if (f.from) qb = qb.where(col, ">=", dayStart(f.from, tz));
  if (f.to) qb = qb.where(col, "<", dayEnd(f.to, tz));
  if (f.platform) qb = qb.where("platforms.code", "=", f.platform);
  if (f.agent) qb = qb.where("leads.agent_id", "=", f.agent);
  if (f.status.length) qb = qb.where("leads.status", "in", f.status as LeadStatus[]);
  if (f.problem === "true") qb = qb.where("leads.status", "in", ["failed", "dead_letter"]);
  if (f.consent) qb = qb.where("leads.consent_status", "=", f.consent);
  if (f.duplicate === "true") qb = qb.where("leads.possible_duplicate_of", "is not", null);
  if (f.duplicate === "false") qb = qb.where("leads.possible_duplicate_of", "is", null);

  const q = f.q;
  if (q) {
    if (/^LD-[0-9A-Z]{26}$/i.test(q)) {
      qb = qb.where("leads.lead_ref", "=", q.toUpperCase());
    } else if (q.includes("@")) {
      qb = qb.where("leads.email_bidx", "=", emailIndex(q, keys));
    } else if (/^\+?[\d\s()-]{6,}$/.test(q)) {
      const phone = parsePhoneNumberFromString(q, config.DEFAULT_PHONE_REGION as CountryCode);
      const e164 = phone?.isValid() ? phone.number : null;
      qb = e164
        ? qb.where("leads.phone_bidx", "=", phoneIndex(e164, keys))
        : qb.where(sql<boolean>`false`);
    } else {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      qb = qb.where((eb: ExpressionBuilder<Database, "leads" | "platforms">) =>
        eb.or([
          eb("leads.external_lead_id", "=", q),
          eb(sql`leads.first_name || ' ' || leads.last_name`, "ilike", like),
        ]),
      );
    }
  }
  return qb;
}

/**
 * Data isolation for restricted users. Provider users see only their platform; organisation users
 * only their organisation. Internal staff (no organisation, no platform) see everything.
 */
export function scopeLeads<QB extends SelectQueryBuilder<Database, "leads" | "platforms", object>>(
  qb: QB,
  admin: AdminContext,
): QB {
  let out = qb;
  if (admin.platformId) out = out.where("leads.platform_id", "=", admin.platformId) as QB;
  if (admin.organisationId)
    out = out.where("leads.organisation_id", "=", admin.organisationId) as QB;
  return out;
}

/** True for lead-provider portal users (they get a reduced view without internal details). */
export const isProviderUser = (admin: AdminContext) => admin.platformId !== null;

export function baseLeadQuery(db: Kysely<Database>, admin: AdminContext): LeadQB {
  const qb = db.selectFrom("leads").innerJoin("platforms", "platforms.id", "leads.platform_id");
  return scopeLeads(qb, admin);
}

// --- Masking ------------------------------------------------------------------

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

export function maskPhone(e164: string | null): string | null {
  if (!e164) return null;
  const parsed = parsePhoneNumberFromString(e164);
  const cc = parsed ? `+${parsed.countryCallingCode}` : e164.slice(0, 3);
  return `${cc} ••• ••• ${e164.slice(-3)}`;
}

export const decryptOrNull = (b: Buffer | null, key: string) => (b ? decrypt(b, key) : null);

/** Turns a filter object back into a query string for drill-down links. */
export function filterToQuery(f: Partial<Record<string, string | undefined>>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}
