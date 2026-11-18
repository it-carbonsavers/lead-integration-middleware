/**
 * deliver-lead job: sends one lead to its destination and records every attempt.
 *
 * Status flow:  queued/retry_scheduled -> delivering -> delivered
 *                                                    -> retry_scheduled  (retryable, retries left; job rethrows)
 *                                                    -> dead_letter      (retryable, retries exhausted)
 *                                                    -> failed           (permanent error; no retries)
 *
 * A lead is "claimed" atomically before delivery, so two jobs for the same lead can never deliver
 * it at the same time. Destination ids are saved after each step so a retry resumes, not duplicates.
 */

import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";
import type { Env } from "@lim/config";
import { DestinationError, QUEUES, type DestinationAdapter } from "@lim/core";
import {
  resolveDestinationForPlatform,
  toCanonicalLead,
  type Database,
  type Destination,
  type Lead,
  type LeadStatus,
} from "@lim/db";
import { createAdapter, type AdapterDeps } from "@lim/destinations";
import type { DeliverLeadJob } from "@lim/jobs";

export interface DeliverDeps {
  db: Kysely<Database>;
  config: Env;
  log: Logger;
  /** Override adapter creation (tests). */
  adapterFor?: (destination: Destination) => DestinationAdapter;
  adapterDeps?: Partial<AdapterDeps>;
}

export interface DeliverJob {
  id: string;
  retryCount: number;
  data: DeliverLeadJob;
}

/** A delivery stuck in "delivering" longer than this (worker crashed) may be re-claimed. */
const STALE_DELIVERY_SECONDS = QUEUES.deliverLead.expireInSeconds + 10;

export type DeliverOutcome = "delivered" | "retry_scheduled" | "dead_letter" | "failed" | "skipped";

export async function deliverLead(deps: DeliverDeps, job: DeliverJob): Promise<DeliverOutcome> {
  const { db, config, log } = deps;
  const keys = {
    encryptionKey: config.APP_ENCRYPTION_KEY,
    blindIndexKey: config.APP_BLIND_INDEX_KEY,
  };

  const lead = await db
    .updateTable("leads")
    .set({
      status: "delivering",
      status_changed_at: sql`now()`,
      attempt_count: sql`attempt_count + 1`,
    })
    .where("id", "=", job.data.leadId)
    .where((eb) =>
      eb.or([
        eb("status", "in", ["queued", "retry_scheduled"]),
        eb.and([
          eb("status", "=", "delivering"),
          eb(
            "status_changed_at",
            "<",
            sql<Date>`now() - make_interval(secs => ${STALE_DELIVERY_SECONDS})`,
          ),
        ]),
      ]),
    )
    .returningAll()
    .executeTakeFirst();

  if (!lead) {
    const current = await db
      .selectFrom("leads")
      .select("status")
      .where("id", "=", job.data.leadId)
      .executeTakeFirst();
    log.info(
      { leadId: job.data.leadId, status: current?.status ?? "missing" },
      "delivery skipped: lead not claimable",
    );
    return "skipped";
  }

  const fromStatus: LeadStatus = job.retryCount > 0 ? "retry_scheduled" : "queued";
  await event(db, lead.id, "delivery_started", fromStatus, "delivering", {
    attempt: lead.attempt_count,
    job_id: job.id,
  });

  const destination =
    (lead.destination_id
      ? await db
          .selectFrom("destinations")
          .selectAll()
          .where("id", "=", lead.destination_id)
          .executeTakeFirst()
      : undefined) ?? (await resolveDestinationForPlatform(db, lead.platform_id));

  if (!destination) {
    await db
      .updateTable("leads")
      .set({ status: "failed", status_changed_at: sql`now()`, last_error_code: "no_destination" })
      .where("id", "=", lead.id)
      .execute();
    await event(db, lead.id, "delivery_failed", "delivering", "failed", {
      error_code: "no_destination",
    });
    log.error({ leadRef: lead.lead_ref }, "no active destination configured");
    return "failed";
  }

  if (lead.destination_id !== destination.id) {
    await db
      .updateTable("leads")
      .set({ destination_id: destination.id })
      .where("id", "=", lead.id)
      .execute();
  }

  const attempt = await db
    .insertInto("delivery_attempts")
    .values({
      lead_id: lead.id,
      destination_id: destination.id,
      attempt_no: lead.attempt_count,
      job_id: job.id,
      status: "in_progress",
      step_results: "{}",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  try {
    const adapter = deps.adapterFor
      ? deps.adapterFor(destination)
      : createAdapter(destination, { db, config, ...deps.adapterDeps });
    const canonical = await buildCanonical(db, lead, keys);
    const existing = Object.fromEntries(
      Object.entries(lead.destination_ids ?? {}).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;

    const result = await adapter.deliver(canonical, {
      existing,
      saveProgress: async (ids) => {
        await db
          .updateTable("leads")
          .set({ destination_ids: sql`destination_ids || ${JSON.stringify(ids)}::jsonb` })
          .where("id", "=", lead.id)
          .execute();
      },
    });

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("delivery_attempts")
        .set({
          status: "success",
          step_results: JSON.stringify(result.steps),
          finished_at: sql`now()`,
        })
        .where("id", "=", attempt.id)
        .execute();
      await trx
        .updateTable("leads")
        .set({
          status: "delivered",
          status_changed_at: sql`now()`,
          delivered_at: sql`now()`,
          last_error_code: null,
          destination_ids: sql`destination_ids || ${JSON.stringify(result.externalIds)}::jsonb`,
        })
        .where("id", "=", lead.id)
        .execute();
      await event(trx, lead.id, "delivered", "delivering", "delivered", {
        destination_type: destination.type,
        steps: result.steps,
        attempt: lead.attempt_count,
      });
    });
    log.info(
      { leadRef: lead.lead_ref, destination: destination.type, steps: result.steps },
      "lead delivered",
    );
    return "delivered";
  } catch (err) {
    const de =
      err instanceof DestinationError
        ? err
        : new DestinationError("retryable", "internal_error", "Unexpected delivery error");
    if (!(err instanceof DestinationError))
      log.error({ err, leadRef: lead.lead_ref }, "unexpected delivery error");

    const exhausted = job.retryCount >= config.DELIVERY_RETRY_LIMIT;
    const nextStatus: LeadStatus =
      de.errorClass === "permanent" ? "failed" : exhausted ? "dead_letter" : "retry_scheduled";

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("delivery_attempts")
        .set({
          status: de.errorClass === "permanent" ? "permanent_error" : "retryable_error",
          http_status: de.httpStatus,
          error_code: de.code,
          error_message: de.message,
          finished_at: sql`now()`,
        })
        .where("id", "=", attempt.id)
        .execute();
      await trx
        .updateTable("leads")
        .set({ status: nextStatus, status_changed_at: sql`now()`, last_error_code: de.code })
        .where("id", "=", lead.id)
        .execute();
      await event(
        trx,
        lead.id,
        nextStatus === "retry_scheduled" ? "delivery_retry_scheduled" : "delivery_failed",
        "delivering",
        nextStatus,
        {
          error_code: de.code,
          error_class: de.errorClass,
          attempt: lead.attempt_count,
          retries_left: Math.max(0, config.DELIVERY_RETRY_LIMIT - job.retryCount),
        },
      );
    });

    log.warn(
      { leadRef: lead.lead_ref, code: de.code, errorClass: de.errorClass, status: nextStatus },
      "lead delivery attempt failed",
    );

    // Permanent failures complete the job (no point retrying). Retryable ones rethrow so pg-boss
    // schedules the next attempt with back-off, or moves the job to the dead-letter queue.
    if (nextStatus === "failed") return "failed";
    throw de;
  }
}

async function buildCanonical(
  db: Kysely<Database>,
  lead: Lead,
  keys: { encryptionKey: string; blindIndexKey: string },
) {
  const platform = await db
    .selectFrom("platforms")
    .select("code")
    .where("id", "=", lead.platform_id)
    .executeTakeFirstOrThrow();
  const agent = lead.agent_id
    ? await db
        .selectFrom("agents")
        .select(["external_agent_id", "name", "destination_owner_id"])
        .where("id", "=", lead.agent_id)
        .executeTakeFirst()
    : undefined;
  return toCanonicalLead(
    lead,
    {
      platformCode: platform.code,
      agent: agent
        ? {
            externalId: agent.external_agent_id,
            name: agent.name,
            ownerId: agent.destination_owner_id,
          }
        : null,
    },
    keys,
  );
}

async function event(
  db: Kysely<Database>,
  leadId: string,
  type: string,
  from: LeadStatus,
  to: LeadStatus,
  detail: Record<string, unknown>,
) {
  await db
    .insertInto("lead_events")
    .values({
      lead_id: leadId,
      type,
      from_status: from,
      to_status: to,
      actor_type: "system",
      detail: JSON.stringify(detail),
    })
    .execute();
}
