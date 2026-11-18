/**
 * Lead submission use case (Lead Processing and Validation).
 *
 *  1. validate + normalise (rejections are recorded too, so they show up in admin/reports)
 *  2. duplicate protection:
 *       - same Idempotency-Key from the same platform  -> replay original answer
 *       - same (platform, external_lead_id)            -> replay original answer, never re-delivered
 *       - same phone/email from any platform within N days -> accepted, flagged possible_duplicate
 *  3. one transaction: agent upsert, lead insert, submission record, timeline event, delivery job
 */

import { sql, type Kysely } from "kysely";
import type { Env } from "@lim/config";
import { encrypt, newLeadRef, normaliseLeadSubmission, problems, type FieldError } from "@lim/core";
import { emailIndex, leadRowFromSubmission, phoneIndex, type Database } from "@lim/db";
import { enqueueDelivery, type PgBoss } from "@lim/jobs";
import type { AuthenticatedPlatform } from "../plugins/platform-auth.js";

export interface SubmitDeps {
  db: Kysely<Database>;
  boss: PgBoss;
  config: Env;
}

export interface SubmitRequest {
  platform: AuthenticatedPlatform;
  requestId: string;
  ip: string;
  idempotencyKey: string | null;
  body: unknown;
}

export interface SubmitResponseBody {
  lead_ref: string;
  external_lead_id: string;
  status: string;
  duplicate: boolean;
  possible_duplicate: boolean;
  received_at: string;
}

export interface SubmitResult {
  httpStatus: 200 | 202;
  body: SubmitResponseBody;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export async function submitLead(deps: SubmitDeps, req: SubmitRequest): Promise<SubmitResult> {
  const { db, config } = deps;
  const keys = {
    encryptionKey: config.APP_ENCRYPTION_KEY,
    blindIndexKey: config.APP_BLIND_INDEX_KEY,
  };

  if (req.idempotencyKey !== null && !IDEMPOTENCY_KEY.test(req.idempotencyKey)) {
    throw problems.badRequest("Idempotency-Key must be 8-128 characters: letters, digits, . _ : -");
  }

  const encryptedPayload = encrypt(JSON.stringify(req.body ?? null), config.APP_ENCRYPTION_KEY);
  const result = normaliseLeadSubmission(req.body, {
    defaultPhoneRegion: config.DEFAULT_PHONE_REGION,
  });

  if (!result.ok) {
    await recordRejection(db, req, result.errors, encryptedPayload);
    throw problems.validation(result.errors);
  }
  const lead = result.lead;

  if (req.idempotencyKey) {
    const replay = await replayByIdempotencyKey(
      db,
      req.platform.id,
      req.idempotencyKey,
      lead.external_lead_id,
    );
    if (replay) return replay;
  }

  try {
    return await db.transaction().execute(async (trx) => {
      const agent = await trx
        .insertInto("agents")
        .values({
          platform_id: req.platform.id,
          external_agent_id: lead.agent.external_id,
          name: lead.agent.name ?? null,
          email: lead.agent.email ?? null,
        })
        .onConflict((oc) =>
          oc.columns(["platform_id", "external_agent_id"]).doUpdateSet({
            name: sql`coalesce(excluded.name, agents.name)`,
            email: sql`coalesce(excluded.email, agents.email)`,
            last_seen_at: sql`now()`,
          }),
        )
        .returning("id")
        .executeTakeFirstOrThrow();

      const retentionUntil = new Date(Date.now() + config.LEAD_RETENTION_DAYS * 86_400_000);
      const inserted = await trx
        .insertInto("leads")
        .values(
          leadRowFromSubmission(
            lead,
            {
              leadRef: newLeadRef(),
              organisationId: req.platform.organisationId,
              platformId: req.platform.id,
              agentId: agent.id,
              retentionUntil,
              destinationId: null,
            },
            keys,
          ),
        )
        .onConflict((oc) => oc.columns(["platform_id", "external_lead_id"]).doNothing())
        .returning(["id", "lead_ref", "status", "received_at", "phone_bidx", "email_bidx"])
        .executeTakeFirst();

      if (!inserted) {
        // Same platform already sent this external_lead_id: replay, never deliver twice.
        const existing = await trx
          .selectFrom("leads")
          .select(["id", "lead_ref", "status", "received_at", "possible_duplicate_of"])
          .where("platform_id", "=", req.platform.id)
          .where("external_lead_id", "=", lead.external_lead_id)
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("submissions")
          .values({
            platform_id: req.platform.id,
            credential_id: req.platform.credentialId,
            lead_id: existing.id,
            external_lead_id: lead.external_lead_id,
            idempotency_key: req.idempotencyKey,
            request_id: req.requestId,
            source_ip: req.ip,
            outcome: "duplicate",
            http_status: 200,
            payload_enc: encryptedPayload,
          })
          .execute();
        return {
          httpStatus: 200 as const,
          body: {
            lead_ref: existing.lead_ref,
            external_lead_id: lead.external_lead_id,
            status: existing.status,
            duplicate: true,
            possible_duplicate: existing.possible_duplicate_of !== null,
            received_at: existing.received_at.toISOString(),
          },
        };
      }

      // Soft duplicate: same customer phone/email recently, from any platform.
      const earlier = await trx
        .selectFrom("leads")
        .select(["id", "lead_ref"])
        .where("id", "<>", inserted.id)
        .where(
          "received_at",
          ">",
          sql<Date>`now() - make_interval(days => ${config.DUPLICATE_WINDOW_DAYS})`,
        )
        .where((eb) =>
          eb.or([
            eb("phone_bidx", "=", phoneIndex(lead.customer.phone, keys)),
            ...(lead.customer.email
              ? [eb("email_bidx", "=", emailIndex(lead.customer.email, keys))]
              : []),
          ]),
        )
        .orderBy("received_at", "asc")
        .limit(1)
        .executeTakeFirst();

      await trx
        .insertInto("lead_events")
        .values({
          lead_id: inserted.id,
          type: "received",
          from_status: null,
          to_status: "queued",
          actor_type: "platform",
          actor_id: req.platform.id,
          detail: JSON.stringify({ request_id: req.requestId, platform: req.platform.code }),
        })
        .execute();

      if (earlier) {
        await trx
          .updateTable("leads")
          .set({ possible_duplicate_of: earlier.id })
          .where("id", "=", inserted.id)
          .execute();
        await trx
          .insertInto("lead_events")
          .values({
            lead_id: inserted.id,
            type: "possible_duplicate",
            actor_type: "system",
            detail: JSON.stringify({
              of_lead_ref: earlier.lead_ref,
              window_days: config.DUPLICATE_WINDOW_DAYS,
            }),
          })
          .execute();
      }

      await trx
        .insertInto("submissions")
        .values({
          platform_id: req.platform.id,
          credential_id: req.platform.credentialId,
          lead_id: inserted.id,
          external_lead_id: lead.external_lead_id,
          idempotency_key: req.idempotencyKey,
          request_id: req.requestId,
          source_ip: req.ip,
          outcome: "accepted",
          http_status: 202,
          payload_enc: encryptedPayload,
        })
        .execute();

      await enqueueDelivery(deps.boss, trx, { leadId: inserted.id });

      return {
        httpStatus: 202 as const,
        body: {
          lead_ref: inserted.lead_ref,
          external_lead_id: lead.external_lead_id,
          status: inserted.status,
          duplicate: false,
          possible_duplicate: earlier !== undefined,
          received_at: inserted.received_at.toISOString(),
        },
      };
    });
  } catch (err) {
    // A concurrent request with the same Idempotency-Key won the race: answer like a replay.
    if (isUniqueViolation(err, "submissions_idempotency_key") && req.idempotencyKey) {
      const replay = await replayByIdempotencyKey(
        db,
        req.platform.id,
        req.idempotencyKey,
        lead.external_lead_id,
      );
      if (replay) return replay;
    }
    throw err;
  }
}

async function replayByIdempotencyKey(
  db: Kysely<Database>,
  platformId: string,
  key: string,
  externalLeadId: string,
): Promise<SubmitResult | null> {
  const prior = await db
    .selectFrom("submissions as s")
    .innerJoin("leads as l", "l.id", "s.lead_id")
    .select([
      "l.lead_ref",
      "l.external_lead_id",
      "l.status",
      "l.received_at",
      "l.possible_duplicate_of",
    ])
    .where("s.platform_id", "=", platformId)
    .where("s.idempotency_key", "=", key)
    .where("s.outcome", "=", "accepted")
    .executeTakeFirst();
  if (!prior) return null;
  if (prior.external_lead_id !== externalLeadId) {
    throw problems.conflict("Idempotency-Key was already used for a different lead");
  }
  return {
    httpStatus: 200,
    body: {
      lead_ref: prior.lead_ref,
      external_lead_id: prior.external_lead_id,
      status: prior.status,
      duplicate: true,
      possible_duplicate: prior.possible_duplicate_of !== null,
      received_at: prior.received_at.toISOString(),
    },
  };
}

async function recordRejection(
  db: Kysely<Database>,
  req: SubmitRequest,
  errors: FieldError[],
  payloadEnc: Buffer,
): Promise<void> {
  const raw = req.body as { external_lead_id?: unknown } | null;
  const ext =
    raw && typeof raw.external_lead_id === "string" && raw.external_lead_id.length <= 100
      ? raw.external_lead_id
      : null;
  await db
    .insertInto("submissions")
    .values({
      platform_id: req.platform.id,
      credential_id: req.platform.credentialId,
      external_lead_id: ext,
      idempotency_key: req.idempotencyKey,
      request_id: req.requestId,
      source_ip: req.ip,
      outcome: "rejected",
      http_status: 422,
      error_summary: JSON.stringify(errors),
      payload_enc: payloadEnc,
    })
    .execute();
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505" &&
    (err as { constraint?: string }).constraint === constraint
  );
}
