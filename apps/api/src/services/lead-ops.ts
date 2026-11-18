/**
 * Operator actions on leads (used by the CLI now and by the admin backend later).
 */

import { sql, type Kysely } from "kysely";
import { writeAudit, type Actor, type Database } from "@lim/db";
import { enqueueDelivery, type PgBoss } from "@lim/jobs";

export class LeadOpError extends Error {}

const RETRYABLE_FROM = ["failed", "dead_letter"] as const;

/** Puts a failed or dead-lettered lead back in the delivery queue. Audited. */
export async function requeueLead(
  db: Kysely<Database>,
  boss: PgBoss,
  leadRef: string,
  actor: Actor,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom("leads")
      .select(["id", "status", "organisation_id"])
      .where("lead_ref", "=", leadRef)
      .forUpdate()
      .executeTakeFirst();
    if (!lead) throw new LeadOpError("lead not found");
    if (!(RETRYABLE_FROM as readonly string[]).includes(lead.status)) {
      throw new LeadOpError(
        `only failed or dead_letter leads can be retried (status is ${lead.status})`,
      );
    }
    await trx
      .updateTable("leads")
      .set({ status: "queued", status_changed_at: sql`now()` })
      .where("id", "=", lead.id)
      .execute();
    await trx
      .insertInto("lead_events")
      .values({
        lead_id: lead.id,
        type: "retry_requested",
        from_status: lead.status,
        to_status: "queued",
        actor_type: actor.type === "admin" ? "admin" : "system",
        actor_id: actor.id ?? null,
        detail: JSON.stringify({ by: actor.label ?? null }),
      })
      .execute();
    await writeAudit(trx, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorLabel: actor.label ?? null,
      organisationId: lead.organisation_id,
      action: "lead.retry_requested",
      requestId: actor.requestId ?? null,
      ip: actor.ip ?? null,
      targetType: "lead",
      targetId: leadRef,
      detail: { from_status: lead.status },
    });
    await enqueueDelivery(boss, trx, { leadId: lead.id });
  });
}
