/**
 * Provider lead endpoints.
 *   POST /v1/leads                         submit one lead (202 accepted / 200 duplicate replay)
 *   GET  /v1/leads/:lead_ref               status of one of the caller's own leads
 *   GET  /v1/leads                         list the caller's own leads (paged; filters: external_lead_id,
 *                                          status, received_from, received_to)
 * A provider can only ever see leads submitted by its own platform.
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { Env } from "@lim/config";
import { problems } from "@lim/core";
import type { Database } from "@lim/db";
import type { PgBoss } from "@lim/jobs";
import { submitLead } from "../../services/submit-lead.js";

export interface LeadRouteOptions {
  db: Kysely<Database>;
  boss: PgBoss;
  config: Env;
}

const isoDateTime = z.iso.datetime({ offset: true });

export const leadListQuerySchema = z.strictObject({
  external_lead_id: z.string().min(1).max(100).optional(),
  status: z
    .enum([
      "queued",
      "delivering",
      "retry_scheduled",
      "delivered",
      "failed",
      "dead_letter",
      "held",
      "discarded",
      "received",
    ])
    .optional(),
  received_from: isoDateTime.optional(),
  received_to: isoDateTime.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export const leadStatusSchema = z.object({
  lead_ref: z.string(),
  external_lead_id: z.string(),
  status: z.string(),
  consent_status: z.string(),
  possible_duplicate: z.boolean(),
  received_at: z.string(),
  delivered_at: z.string().nullable(),
});

export const leadListSchema = z.object({
  items: z.array(leadStatusSchema),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
});

export async function leadRoutes(app: FastifyInstance, opts: LeadRouteOptions): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/leads", async (request, reply) => {
    const header = request.headers["idempotency-key"];
    const result = await submitLead(opts, {
      platform: request.platform!,
      requestId: request.id,
      ip: request.ip,
      idempotencyKey: typeof header === "string" ? header : null,
      body: request.body,
    });
    if (result.httpStatus === 202) reply.header("location", `/v1/leads/${result.body.lead_ref}`);
    return reply.code(result.httpStatus).send(result.body);
  });

  const select = () =>
    opts.db
      .selectFrom("leads")
      .select([
        "lead_ref",
        "external_lead_id",
        "status",
        "consent_status",
        "possible_duplicate_of",
        "received_at",
        "delivered_at",
      ]);

  type Row = Awaited<ReturnType<ReturnType<typeof select>["executeTakeFirstOrThrow"]>>;
  const present = (l: Row) => ({
    lead_ref: l.lead_ref,
    external_lead_id: l.external_lead_id,
    status: l.status,
    consent_status: l.consent_status,
    possible_duplicate: l.possible_duplicate_of !== null,
    received_at: l.received_at.toISOString(),
    delivered_at: l.delivered_at?.toISOString() ?? null,
  });

  r.get(
    "/leads/:lead_ref",
    {
      schema: {
        params: z.object({ lead_ref: z.string().regex(/^LD-[0-9A-Z]{26}$/) }),
        response: { 200: leadStatusSchema },
      },
    },
    async (request) => {
      const lead = await select()
        .where("lead_ref", "=", request.params.lead_ref)
        .where("platform_id", "=", request.platform!.id)
        .executeTakeFirst();
      if (!lead) throw problems.notFound();
      return present(lead);
    },
  );

  r.get(
    "/leads",
    {
      schema: {
        querystring: leadListQuerySchema,
        response: { 200: leadListSchema },
      },
    },
    async (request) => {
      const q = request.query;
      let qb = opts.db.selectFrom("leads").where("platform_id", "=", request.platform!.id);
      if (q.external_lead_id) qb = qb.where("external_lead_id", "=", q.external_lead_id);
      if (q.status) qb = qb.where("status", "=", q.status);
      if (q.received_from) qb = qb.where("received_at", ">=", new Date(q.received_from));
      if (q.received_to) qb = qb.where("received_at", "<", new Date(q.received_to));
      const [{ total }] = (await qb.select(sql<number>`count(*)::int`.as("total")).execute()) as [
        { total: number },
      ];
      const rows = await qb
        .select([
          "lead_ref",
          "external_lead_id",
          "status",
          "consent_status",
          "possible_duplicate_of",
          "received_at",
          "delivered_at",
        ])
        .orderBy("received_at", "desc")
        .orderBy("lead_ref", "desc")
        .limit(q.page_size)
        .offset((q.page - 1) * q.page_size)
        .execute();
      return { items: rows.map(present), total, page: q.page, page_size: q.page_size };
    },
  );
}
