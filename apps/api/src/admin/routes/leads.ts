/**
 * Admin lead endpoints.
 *   GET  /leads                list (masked), filters, search, pagination
 *   GET  /leads/export.csv     CSV export of the current filter (masked, max 10,000 rows, audited)
 *   GET  /leads/:ref           detail (masked) + timeline + attempts + submissions (view audited)
 *   POST /leads/:ref/reveal    full personal data (permission leads.pii_reveal, audited)
 *   POST /leads/:ref/retry     re-queue failed / dead_letter lead (permission leads.operate, audited)
 *   GET  /submissions          inbound submissions incl. rejected ones
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql } from "kysely";
import { z } from "zod";
import { decrypt, problems } from "@lim/core";
import { decryptLeadPii, writeAudit } from "@lim/db";
import { requeueLead, LeadOpError } from "../../services/lead-ops.js";
import { requirePermission, actorOf, type AdminContext } from "../auth.js";
import {
  applyLeadFilters,
  baseLeadQuery,
  dayEnd,
  dayStart,
  decryptOrNull,
  leadFilterSchema,
  maskEmail,
  isProviderUser,
  maskPhone,
} from "../lead-query.js";
import type { AdminRouteOptions } from "./index.js";
import { workflowFacts } from "./overview.js";

const refParam = z.object({ ref: z.string().regex(/^LD-[0-9A-Z]{26}$/) });
const page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(["received_at", "transferred_at"]).default("received_at"),
});

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function adminLeadRoutes(app: FastifyInstance, opts: AdminRouteOptions) {
  const { db, config, boss } = opts;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const key = config.APP_ENCRYPTION_KEY;

  const listColumns = (qb: ReturnType<typeof baseLeadQuery>) =>
    qb
      .leftJoin("agents", "agents.id", "leads.agent_id")
      .leftJoin("leads as dup", "dup.id", "leads.possible_duplicate_of")
      .select([
        "leads.lead_ref",
        "leads.external_lead_id",
        "platforms.code as platform",
        "agents.external_agent_id as agent_external_id",
        "agents.name as agent_name",
        "leads.first_name",
        "leads.last_name",
        "leads.phone_enc",
        "leads.email_enc",
        "leads.status",
        "leads.consent_status",
        "dup.lead_ref as possible_duplicate_of",
        "leads.transferred_at",
        "leads.received_at",
        "leads.delivered_at",
        "leads.attempt_count",
        "leads.last_error_code",
      ]);

  type ListRow = Awaited<ReturnType<ReturnType<typeof listColumns>["execute"]>>[number];
  const present = (row: ListRow, provider = false) => {
    const { phone_enc, email_enc, ...rest } = row;
    return {
      ...rest,
      phone: maskPhone(decrypt(phone_enc, key)),
      email: maskEmail(decryptOrNull(email_enc, key)),
      possible_duplicate: row.possible_duplicate_of !== null,
      // Provider users must not learn other providers' lead references or our internal error codes.
      ...(provider ? { possible_duplicate_of: null, last_error_code: null } : {}),
    };
  };

  r.get(
    "/leads",
    {
      preHandler: requirePermission("leads.read"),
      schema: { querystring: leadFilterSchema.extend(page.shape) },
    },
    async (req) => {
      const { page: pg, pageSize, sort, ...filter } = req.query;
      const filtered = applyLeadFilters(baseLeadQuery(db, req.admin!), filter, config);
      const [{ total }] = (await filtered
        .select(sql<number>`count(*)::int`.as("total"))
        .execute()) as [{ total: number }];
      const rows = await listColumns(filtered)
        .orderBy(sort === "transferred_at" ? "leads.transferred_at" : "leads.received_at", "desc")
        .orderBy("leads.lead_ref", "desc")
        .limit(pageSize)
        .offset((pg - 1) * pageSize)
        .execute();
      if (filter.q) {
        await writeAudit(db, {
          actorType: "admin",
          actorId: req.admin!.id,
          actorLabel: req.admin!.email,
          action: "lead.search",
          requestId: req.id,
          ip: req.ip,
          detail: {
            search_kind: filter.q.includes("@")
              ? "email"
              : /^\+?[\d\s()-]{6,}$/.test(filter.q)
                ? "phone"
                : "text",
            results: total,
          },
        });
      }
      return {
        items: rows.map((r) => present(r, isProviderUser(req.admin!))),
        total,
        page: pg,
        pageSize,
      };
    },
  );

  r.get(
    "/leads/export.csv",
    { preHandler: requirePermission("leads.export"), schema: { querystring: leadFilterSchema } },
    async (req, reply) => {
      const MAX = 10_000;
      const rows = await listColumns(
        applyLeadFilters(baseLeadQuery(db, req.admin!), req.query, config),
      )
        .orderBy("leads.received_at", "desc")
        .limit(MAX + 1)
        .execute();
      if (rows.length > MAX)
        throw problems.badRequest(`Export limited to ${MAX} rows; narrow the filters`);
      const header = [
        "lead_ref",
        "external_lead_id",
        "platform",
        "agent_external_id",
        "agent_name",
        "first_name",
        "last_name",
        "phone_masked",
        "email_masked",
        "status",
        "consent_status",
        "possible_duplicate_of",
        "transferred_at",
        "received_at",
        "delivered_at",
        "attempt_count",
        "last_error_code",
      ];
      const lines = [header.join(",")];
      for (const row of rows) {
        const p = present(row, isProviderUser(req.admin!));
        lines.push(
          [
            p.lead_ref,
            p.external_lead_id,
            p.platform,
            p.agent_external_id,
            p.agent_name,
            p.first_name,
            p.last_name,
            p.phone,
            p.email,
            p.status,
            p.consent_status,
            p.possible_duplicate_of,
            p.transferred_at,
            p.received_at,
            p.delivered_at,
            p.attempt_count,
            p.last_error_code,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      await writeAudit(db, {
        actorType: "admin",
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        organisationId: req.admin!.organisationId,
        action: "lead.export",
        requestId: req.id,
        ip: req.ip,
        detail: {
          rows: rows.length,
          filters: { ...req.query, q: req.query.q ? "[search]" : undefined },
        },
      });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="leads-${stamp}.csv"`)
        .send(lines.join("\r\n") + "\r\n");
    },
  );

  const loadLead = async (ref: string, admin: AdminContext) => {
    let qb = db
      .selectFrom("leads")
      .innerJoin("platforms", "platforms.id", "leads.platform_id")
      .selectAll("leads")
      .select(["platforms.code as platform_code", "platforms.display_name as platform_name"])
      .where("leads.lead_ref", "=", ref);
    if (admin.organisationId) qb = qb.where("leads.organisation_id", "=", admin.organisationId);
    if (admin.platformId) qb = qb.where("leads.platform_id", "=", admin.platformId);
    const lead = await qb.executeTakeFirst();
    if (!lead) throw problems.notFound();
    return lead;
  };

  r.get(
    "/leads/:ref",
    { preHandler: requirePermission("leads.read"), schema: { params: refParam } },
    async (req) => {
      const lead = await loadLead(req.params.ref, req.admin!);
      const pii = decryptLeadPii(lead, {
        encryptionKey: key,
        blindIndexKey: config.APP_BLIND_INDEX_KEY,
      });
      const [
        agent,
        destination,
        duplicateOf,
        duplicates,
        events,
        attempts,
        submissions,
        recordings,
      ] = await Promise.all([
        lead.agent_id
          ? db
              .selectFrom("agents")
              .select(["id", "external_agent_id", "name", "destination_owner_id"])
              .where("id", "=", lead.agent_id)
              .executeTakeFirst()
          : undefined,
        lead.destination_id
          ? db
              .selectFrom("destinations")
              .select(["id", "name", "type"])
              .where("id", "=", lead.destination_id)
              .executeTakeFirst()
          : undefined,
        lead.possible_duplicate_of
          ? db
              .selectFrom("leads")
              .select("lead_ref")
              .where("id", "=", lead.possible_duplicate_of)
              .executeTakeFirst()
          : undefined,
        db
          .selectFrom("leads")
          .select("lead_ref")
          .where("possible_duplicate_of", "=", lead.id)
          .execute(),
        db
          .selectFrom("lead_events")
          .select(["id", "created_at", "type", "from_status", "to_status", "actor_type", "detail"])
          .where("lead_id", "=", lead.id)
          .orderBy("id")
          .execute(),
        db
          .selectFrom("delivery_attempts")
          .select([
            "attempt_no",
            "status",
            "http_status",
            "error_code",
            "error_message",
            "step_results",
            "started_at",
            "finished_at",
          ])
          .where("lead_id", "=", lead.id)
          .orderBy("attempt_no")
          .execute(),
        db
          .selectFrom("submissions")
          .select([
            "received_at",
            "outcome",
            "http_status",
            "request_id",
            "source_ip",
            "idempotency_key",
          ])
          .where("lead_id", "=", lead.id)
          .orderBy("received_at")
          .execute(),
        db
          .selectFrom("consent_recordings")
          .select([
            "id",
            "original_filename",
            "status",
            "size_bytes",
            "content_type",
            "matched_by",
            "created_at",
          ])
          .where("lead_id", "=", lead.id)
          .orderBy("created_at")
          .execute(),
      ]);
      await writeAudit(db, {
        actorType: "admin",
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        organisationId: lead.organisation_id,
        action: "lead.view",
        targetType: "lead",
        targetId: lead.lead_ref,
        requestId: req.id,
        ip: req.ip,
      });
      const detail = {
        lead_ref: lead.lead_ref,
        external_lead_id: lead.external_lead_id,
        platform: { code: lead.platform_code, name: lead.platform_name },
        agent: agent ?? null,
        status: lead.status,
        consent: {
          status: lead.consent_status,
          verbal_consent: lead.verbal_consent,
          captured_at: lead.consent_captured_at,
          recording_ref: lead.recording_ref,
        },
        customer: {
          first_name: lead.first_name,
          last_name: lead.last_name,
          phone: maskPhone(pii.phone),
          email: maskEmail(pii.email),
          location: {
            city: pii.address?.city ?? null,
            state: lead.state,
            postcode: lead.postcode,
            country: lead.country,
          },
          has_address: pii.address !== null,
          has_notes: pii.notes !== null,
          has_extra: pii.extra !== null,
        },
        campaign: lead.campaign,
        product_interest: lead.product_interest,
        energy_plan: lead.energy_plan,
        transferred_at: lead.transferred_at,
        received_at: lead.received_at,
        delivered_at: lead.delivered_at,
        attempt_count: lead.attempt_count,
        last_error_code: lead.last_error_code,
        destination: destination ?? null,
        destination_ids: lead.destination_ids,
        possible_duplicate_of: duplicateOf?.lead_ref ?? null,
        duplicates_of_this: duplicates.map((d) => d.lead_ref),
        retention_until: lead.retention_until,
        events,
        attempts,
        submissions,
        recordings,
        consent_workflow: await workflowFacts(db, lead.id),
      };
      if (!isProviderUser(req.admin!))
        return { ...detail, possible_duplicate: detail.possible_duplicate_of !== null };
      // Lead-provider view: delivery outcome only. No CRM ids, destination, internal error codes,
      // owner mapping, or references to leads from other providers.
      return {
        ...detail,
        agent: detail.agent ? { ...detail.agent, destination_owner_id: null } : null,
        last_error_code: null,
        destination: null,
        destination_ids: {},
        possible_duplicate: detail.possible_duplicate_of !== null,
        possible_duplicate_of: null,
        duplicates_of_this: [],
        events: detail.events.map((e) => ({ ...e, detail: {} })),
        attempts: detail.attempts.map((a) => ({
          attempt_no: a.attempt_no,
          status: a.status,
          http_status: null,
          error_code: null,
          error_message: null,
          step_results: {},
          started_at: a.started_at,
          finished_at: a.finished_at,
        })),
      };
    },
  );

  r.post(
    "/leads/:ref/reveal",
    { preHandler: requirePermission("leads.pii_reveal"), schema: { params: refParam } },
    async (req) => {
      const lead = await loadLead(req.params.ref, req.admin!);
      const pii = decryptLeadPii(lead, {
        encryptionKey: key,
        blindIndexKey: config.APP_BLIND_INDEX_KEY,
      });
      await writeAudit(db, {
        actorType: "admin",
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        organisationId: lead.organisation_id,
        action: "lead.pii_reveal",
        targetType: "lead",
        targetId: lead.lead_ref,
        requestId: req.id,
        ip: req.ip,
      });
      return {
        email: pii.email,
        phone: pii.phone,
        address: pii.address,
        notes: pii.notes,
        extra: pii.extra,
      };
    },
  );

  r.post(
    "/leads/:ref/retry",
    { preHandler: requirePermission("leads.operate"), schema: { params: refParam } },
    async (req) => {
      await loadLead(req.params.ref, req.admin!);
      try {
        await requeueLead(db, boss, req.params.ref, actorOf(req));
      } catch (e) {
        if (e instanceof LeadOpError) throw problems.conflict(e.message);
        throw e;
      }
      return { ok: true, status: "queued" };
    },
  );

  r.get(
    "/submissions",
    {
      preHandler: requirePermission("leads.read"),
      schema: {
        querystring: z.object({
          outcome: z.enum(["accepted", "duplicate", "rejected"]).optional(),
          platform: z.string().max(16).optional(),
          from: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          to: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          ...page.pick({ page: true, pageSize: true }).shape,
        }),
      },
    },
    async (req) => {
      const q = req.query;
      let qb = db
        .selectFrom("submissions as s")
        .innerJoin("platforms as p", "p.id", "s.platform_id")
        .leftJoin("leads as l", "l.id", "s.lead_id");
      if (req.admin!.organisationId)
        qb = qb.where("p.organisation_id", "=", req.admin!.organisationId);
      if (req.admin!.platformId) qb = qb.where("s.platform_id", "=", req.admin!.platformId);
      if (q.outcome) qb = qb.where("s.outcome", "=", q.outcome);
      if (q.platform) qb = qb.where("p.code", "=", q.platform);
      if (q.from) qb = qb.where("s.received_at", ">=", dayStart(q.from, config.REPORT_TIMEZONE));
      if (q.to) qb = qb.where("s.received_at", "<", dayEnd(q.to, config.REPORT_TIMEZONE));
      const [{ total }] = (await qb.select(sql<number>`count(*)::int`.as("total")).execute()) as [
        { total: number },
      ];
      const items = await qb
        .select([
          "s.id",
          "s.received_at",
          "p.code as platform",
          "s.outcome",
          "s.http_status",
          "s.external_lead_id",
          "s.error_summary",
          "s.request_id",
          "s.source_ip",
          "l.lead_ref",
        ])
        .orderBy("s.received_at", "desc")
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute();
      return { items, total, page: q.page, pageSize: q.pageSize };
    },
  );
}
