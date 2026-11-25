/**
 * sync-outcomes: copies what happened to delivered leads from HubSpot into lead_outcomes.
 *
 * READ-ONLY towards HubSpot. Only leads in this environment's own database are looked up, by the
 * HubSpot Lead id saved when the lead was delivered. On the development environment that means
 * only the TEST leads routed to HubSpot; production reads the leads it delivered itself.
 *
 * Each run refreshes up to OUTCOME_SYNC_BATCH leads received within OUTCOME_SYNC_WINDOW_DAYS,
 * never-synced leads first, then the longest since their last refresh.
 */

import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";
import type { Env } from "@lim/config";
import { touchServiceStatus, type Database, type LeadOutcome } from "@lim/db";
import {
  createOutcomeReader,
  type AdapterDeps,
  type LeadOutcomeRead,
  type OutcomeLookup,
} from "@lim/destinations";

export interface OutcomeSyncDeps {
  db: Kysely<Database>;
  config: Env;
  log: Pick<Logger, "info" | "warn">;
  adapterDeps?: Partial<Omit<AdapterDeps, "db" | "config">>;
  now?: () => Date;
}

export interface OutcomeSyncResult {
  status: "disabled" | "done";
  checked: number;
  updated: number;
  missing: number;
  errors: { destinationId: string; code: string }[];
  dealsUnreadable: string | null;
}

export async function runOutcomeSync(deps: OutcomeSyncDeps): Promise<OutcomeSyncResult> {
  const { db, config } = deps;
  const result: OutcomeSyncResult = {
    status: "done",
    checked: 0,
    updated: 0,
    missing: 0,
    errors: [],
    dealsUnreadable: null,
  };
  if (!config.OUTCOME_SYNC_ENABLED) {
    await touchServiceStatus(db, "outcome-sync", { ...result, status: "disabled" });
    return { ...result, status: "disabled" };
  }

  const rows = await db
    .selectFrom("leads as l")
    .innerJoin("destinations as d", "d.id", "l.destination_id")
    .leftJoin("lead_outcomes as o", "o.lead_id", "l.id")
    .select([
      "l.id as leadId",
      "l.received_at as receivedAt",
      "l.destination_id as destinationId",
      sql<string>`l.destination_ids->>'leadId'`.as("hubspotLeadId"),
      sql<string | null>`l.destination_ids->>'contactId'`.as("contactId"),
    ])
    .where("d.type", "=", "hubspot")
    .where("l.status", "=", "delivered")
    .where(sql<boolean>`l.destination_ids->>'leadId' IS NOT NULL`)
    .where(
      "l.received_at",
      ">=",
      sql<Date>`now() - make_interval(days => ${config.OUTCOME_SYNC_WINDOW_DAYS})`,
    )
    .orderBy(sql`o.synced_at ASC NULLS FIRST`)
    .orderBy("l.received_at", "desc")
    .limit(config.OUTCOME_SYNC_BATCH)
    .execute();

  const byDestination = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.destinationId) continue;
    const list = byDestination.get(r.destinationId) ?? [];
    list.push(r);
    byDestination.set(r.destinationId, list);
  }

  for (const [destinationId, leads] of byDestination) {
    const destination = await db
      .selectFrom("destinations")
      .selectAll()
      .where("id", "=", destinationId)
      .executeTakeFirstOrThrow();
    const reader = createOutcomeReader(destination, { config, ...deps.adapterDeps });
    if (!reader) continue;

    const lookups: OutcomeLookup[] = leads.map((l) => ({
      hubspotLeadId: l.hubspotLeadId,
      contactId: l.contactId,
      receivedAt: l.receivedAt,
    }));
    try {
      const read = await reader.read(lookups);
      result.checked += leads.length;
      if (read.dealsUnreadable) result.dealsUnreadable = read.dealsUnreadable;
      const previous = await db
        .selectFrom("lead_outcomes")
        .selectAll()
        .where(
          "lead_id",
          "in",
          leads.map((l) => l.leadId),
        )
        .execute();
      const prevById = new Map(previous.map((p) => [p.lead_id, p]));
      for (const [i, outcome] of read.outcomes.entries()) {
        const lead = leads[i]!;
        await saveOutcome(
          db,
          lead.leadId,
          outcome,
          prevById.get(lead.leadId),
          !read.dealsUnreadable,
          deps.now?.() ?? new Date(),
        );
        result.updated++;
        if (outcome.missing) result.missing++;
      }
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "error";
      result.errors.push({ destinationId, code });
      deps.log.warn({ destinationId, code }, "outcome sync failed for destination");
    }
  }

  if (result.checked || result.errors.length) deps.log.info(result, "outcome sync");
  await touchServiceStatus(db, "outcome-sync", { ...result });
  return result;
}

async function saveOutcome(
  db: Kysely<Database>,
  leadId: string,
  o: LeadOutcomeRead,
  prev: LeadOutcome | undefined,
  dealsRead: boolean,
  now: Date,
): Promise<void> {
  const stageChangedAt =
    o.leadStageEnteredAt ??
    (prev && prev.lead_stage_id === o.leadStageId ? prev.lead_stage_changed_at : now);

  const leadSide = {
    hubspot_lead_id: o.hubspotLeadId,
    missing: o.missing,
    synced_at: now,
    ...(o.missing
      ? {}
      : {
          lead_stage_id: o.leadStageId,
          lead_stage: o.leadStage,
          lead_stage_changed_at: stageChangedAt,
          disqualification_reason: o.disqualificationReason,
          calls_attempted: o.callsAttempted,
          calls_connected: o.callsConnected,
        }),
  };

  const d = o.deal;
  // Keep the first date a sale was seen when HubSpot has no stage-entry date for it.
  const soldAt = d?.sold
    ? (d.soldAt ?? (prev?.sold && prev.deal_id === d.dealId ? prev.sold_at : now))
    : null;
  const dealSide =
    dealsRead && !o.missing
      ? {
          deal_count: o.dealCount,
          deal_id: d?.dealId ?? null,
          deal_pipeline: d?.pipeline ?? null,
          deal_stage: d?.stage ?? null,
          deal_created_at: d?.createdAt ?? null,
          proposal_sent_at: d?.proposalSentAt ?? null,
          proposal_status: d?.proposalStatus ?? null,
          lost: d?.lost ?? false,
          lost_reason: d?.lostReason ?? null,
          sold: d?.sold ?? false,
          sold_at: soldAt,
          sale_value: d?.saleValue ?? null,
          sale_value_field: d?.saleValueField ?? null,
        }
      : {};

  const values = { ...leadSide, ...dealSide };
  await db
    .insertInto("lead_outcomes")
    .values({ lead_id: leadId, ...values })
    .onConflict((oc) => oc.column("lead_id").doUpdateSet(values))
    .execute();
}
