/**
 * Data retention for leads and raw submissions (recordings are handled in @lim/recordings).
 *
 *  - Leads past retention_until are ANONYMISED, not deleted, so reports keep their counts and
 *    the audit trail stays intact: names are replaced, email/phone/address/notes/extra are
 *    removed, blind indexes are destroyed (the lead can no longer be found by email or phone).
 *    Postcode/state/country, statuses, dates and provider/agent links are kept for reporting.
 *  - Raw submission payloads (encrypted) are removed after `payloadDays`.
 * Both actions are audited with counts only. Retention periods are placeholders until agreed (Q16).
 */

import { randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { encrypt } from "@lim/core";
import type { Database } from "./schema.js";
import { writeAudit } from "./repositories/audit.js";

export async function anonymiseExpiredLeads(
  db: Kysely<Database>,
  encryptionKey: string,
  batch = 500,
): Promise<number> {
  const due = await db
    .selectFrom("leads")
    .select("id")
    .where("retention_until", "<", sql<Date>`now()`)
    .where("anonymised_at", "is", null)
    .limit(batch)
    .execute();
  for (const { id } of due) {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("leads")
        .set({
          first_name: "[removed]",
          last_name: "[removed]",
          email_enc: null,
          email_bidx: null,
          phone_enc: encrypt("", encryptionKey),
          phone_bidx: randomBytes(32), // unsearchable placeholder (column is NOT NULL)
          address_enc: null,
          notes_enc: null,
          extra_enc: null,
          anonymised_at: sql`now()`,
        })
        .where("id", "=", id)
        .execute();
      await trx
        .updateTable("submissions")
        .set({ payload_enc: null })
        .where("lead_id", "=", id)
        .execute();
      await trx
        .insertInto("lead_events")
        .values({
          lead_id: id,
          type: "personal_data_removed",
          actor_type: "system",
          detail: JSON.stringify({ reason: "retention" }),
        })
        .execute();
    });
  }
  if (due.length) {
    await writeAudit(db, {
      actorType: "system",
      actorLabel: "retention-purge",
      action: "lead.anonymised",
      targetType: "lead",
      detail: { count: due.length },
    });
  }
  return due.length;
}

export async function purgeOldPayloads(db: Kysely<Database>, payloadDays: number): Promise<number> {
  const res = await db
    .updateTable("submissions")
    .set({ payload_enc: null })
    .where("payload_enc", "is not", null)
    .where("received_at", "<", sql<Date>`now() - make_interval(days => ${payloadDays})`)
    .executeTakeFirst();
  const n = Number(res.numUpdatedRows);
  if (n) {
    await writeAudit(db, {
      actorType: "system",
      actorLabel: "retention-purge",
      action: "submission.payloads_purged",
      targetType: "submission",
      detail: { count: n, older_than_days: payloadDays },
    });
  }
  return n;
}

/** Records that a background component is alive (and optional details for the status page). */
export async function touchServiceStatus(
  db: Kysely<Database>,
  name: string,
  detail: Record<string, unknown> = {},
) {
  await db
    .insertInto("service_status")
    .values({ name, detail: JSON.stringify(detail) })
    .onConflict((oc) =>
      oc.column("name").doUpdateSet({ last_seen_at: sql`now()`, detail: JSON.stringify(detail) }),
    )
    .execute();
}
