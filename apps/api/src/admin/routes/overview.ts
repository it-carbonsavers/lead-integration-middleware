/**
 * Endpoints behind the simplified dashboard.
 *   GET /overview?days=30         headline figures, leads by source, top agents, recent leads   leads.read
 *   GET /consent                  leads needing / having consent recordings + workflow stage    recordings.read
 *   GET /consent/summary          counts for the Consent Recordings page                        recordings.read
 *   GET /options                  sources and agents for filter dropdowns                       leads.read
 * All scoped: provider-portal users only ever see their own source.
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { Database } from "@lim/db";
import { requirePermission, type AdminContext } from "../auth.js";
import { baseLeadQuery } from "../lead-query.js";
import type { AdminRouteOptions } from "./index.js";

export const WORKFLOW_STEPS = [
  { key: "received", label: "Lead received" },
  { key: "recorded", label: "Lead recorded" },
  { key: "identified", label: "Consent recording identified" },
  { key: "transferred", label: "File transferred" },
  { key: "matched", label: "Recording matched to lead" },
  { key: "completed", label: "Transfer completed" },
] as const;

export type StepState = "done" | "current" | "waiting" | "problem" | "not_applicable";

/** Builds the consent workflow for one lead from its stored facts. */
export function consentWorkflow(lead: {
  received_at: Date;
  verbal_consent: boolean;
  consent_status: string;
  recording_ref: string | null;
  first_recording_at: Date | null;
  matched_at: Date | null;
  synced_at: Date | null;
  delivered: boolean;
}) {
  const at = (d: Date | null) => (d ? d.toISOString() : null);
  if (!lead.verbal_consent) {
    return WORKFLOW_STEPS.map((s, i) => ({
      ...s,
      state: (i < 2 ? "done" : "not_applicable") as StepState,
      at: i < 2 ? at(lead.received_at) : null,
      note:
        i === 2 ? "No verbal consent was captured on the call, so no recording is expected." : null,
    }));
  }
  const overdue = lead.consent_status === "overdue";
  const transferred = lead.first_recording_at !== null;
  const matched = lead.consent_status === "matched";
  // Completed once matched and, if the lead was already delivered, the CRM was updated (or it will carry it on delivery).
  const completed = matched && (lead.synced_at !== null || !lead.delivered);
  const states: StepState[] = [
    "done",
    "done",
    "done",
    transferred ? "done" : overdue ? "problem" : "current",
    matched ? "done" : transferred ? "current" : "waiting",
    completed ? "done" : matched ? "current" : "waiting",
  ];
  const times = [
    lead.received_at,
    lead.received_at,
    lead.received_at,
    lead.first_recording_at,
    lead.matched_at,
    lead.synced_at ?? lead.matched_at,
  ];
  const notes: (string | null)[] = [
    null,
    null,
    lead.recording_ref
      ? `Expected file reference: ${lead.recording_ref}`
      : "Expected file named after the lead's id",
    overdue
      ? "Recording not received within the agreed time. Check the source's transfers."
      : transferred
        ? null
        : "Waiting for the provider to deliver the recording.",
    null,
    null,
  ];
  return WORKFLOW_STEPS.map((s, i) => ({
    ...s,
    state: states[i]!,
    at: states[i] === "done" ? at(times[i] ?? null) : null,
    note: notes[i] ?? null,
  }));
}

export async function workflowFacts(db: Kysely<Database>, leadId: string) {
  const r = await db
    .selectFrom("leads as l")
    .select([
      "l.received_at",
      "l.verbal_consent",
      "l.consent_status",
      "l.recording_ref",
      "l.status",
      sql<Date | null>`(SELECT min(created_at) FROM consent_recordings c WHERE c.lead_id = l.id)`.as(
        "first_recording_at",
      ),
      sql<Date | null>`(SELECT max(matched_at) FROM consent_recordings c WHERE c.lead_id = l.id)`.as(
        "matched_at",
      ),
      sql<Date | null>`(SELECT max(created_at) FROM lead_events e WHERE e.lead_id = l.id AND e.type = 'consent_status_synced')`.as(
        "synced_at",
      ),
    ])
    .where("l.id", "=", leadId)
    .executeTakeFirstOrThrow();
  return consentWorkflow({ ...r, delivered: r.status === "delivered" });
}

export async function adminOverviewRoutes(app: FastifyInstance, opts: AdminRouteOptions) {
  const { db } = opts;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/overview",
    {
      preHandler: requirePermission("leads.read"),
      schema: {
        querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      },
    },
    async (req) => {
      const a = req.admin!;
      const since = sql<Date>`now() - make_interval(days => ${req.query.days})`;
      const base = () => baseLeadQuery(db, a).where("leads.received_at", ">=", since);
      const [totals] = await base()
        .select([
          sql<number>`count(*)::int`.as("received"),
          sql<number>`count(*) FILTER (WHERE leads.status = 'delivered')::int`.as("delivered"),
          sql<number>`count(*) FILTER (WHERE leads.status IN ('received','queued','delivering','retry_scheduled','held'))::int`.as(
            "pending",
          ),
          sql<number>`count(*) FILTER (WHERE leads.status IN ('failed','dead_letter'))::int`.as(
            "failed",
          ),
          sql<number>`count(*) FILTER (WHERE leads.consent_status IN ('awaiting_recording','overdue'))::int`.as(
            "consent_pending",
          ),
          sql<number>`count(*) FILTER (WHERE leads.consent_status = 'overdue')::int`.as(
            "consent_overdue",
          ),
        ])
        .execute();
      const bySource = await base()
        .select([
          "platforms.code",
          "platforms.display_name",
          sql<number>`count(*)::int`.as("leads"),
        ])
        .groupBy(["platforms.code", "platforms.display_name"])
        .orderBy(sql`count(*)`, "desc")
        .limit(8)
        .execute();
      const byAgent = await base()
        .innerJoin("agents", "agents.id", "leads.agent_id")
        .select([
          "agents.id",
          "agents.external_agent_id",
          "agents.name",
          "platforms.code",
          sql<number>`count(*)::int`.as("leads"),
          sql<number>`count(*) FILTER (WHERE leads.status = 'delivered')::int`.as("delivered"),
        ])
        .groupBy(["agents.id", "agents.external_agent_id", "agents.name", "platforms.code"])
        .orderBy(sql`count(*)`, "desc")
        .limit(6)
        .execute();
      const recent = await baseLeadQuery(db, a)
        .select([
          "leads.lead_ref",
          "leads.first_name",
          "leads.last_name",
          "platforms.code",
          "leads.status",
          "leads.consent_status",
          "leads.received_at",
        ])
        .orderBy("leads.received_at", "desc")
        .limit(6)
        .execute();
      return { days: req.query.days, totals, by_source: bySource, by_agent: byAgent, recent };
    },
  );

  /** Filter choices for dropdowns (sources and agents the user may see). */
  r.get("/options", { preHandler: requirePermission("leads.read") }, async (req) => {
    const a = req.admin!;
    let sources = db.selectFrom("platforms").select(["id", "code", "display_name", "status"]);
    if (a.platformId) sources = sources.where("id", "=", a.platformId);
    if (a.organisationId) sources = sources.where("organisation_id", "=", a.organisationId);
    let agents = db
      .selectFrom("agents")
      .innerJoin("platforms", "platforms.id", "agents.platform_id")
      .select([
        "agents.id",
        "agents.external_agent_id",
        "agents.name",
        "platforms.code as platform",
      ]);
    if (a.platformId) agents = agents.where("agents.platform_id", "=", a.platformId);
    if (a.organisationId) agents = agents.where("platforms.organisation_id", "=", a.organisationId);
    return {
      sources: (await sources.orderBy("code").execute()).map((p) => ({
        code: p.code,
        name: p.display_name,
        status: p.status,
      })),
      agents: await agents
        .orderBy("platforms.code")
        .orderBy("agents.external_agent_id")
        .limit(500)
        .execute(),
    };
  });

  const consentFilter = z.object({
    view: z.enum(["needs_recording", "overdue", "matched", "all"]).default("needs_recording"),
    platform: z.string().max(16).optional(),
    q: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  });

  const consentBase = (a: AdminContext) =>
    baseLeadQuery(db, a).where("leads.verbal_consent", "=", true);

  r.get(
    "/consent/summary",
    {
      preHandler: requirePermission("recordings.read"),
      schema: { querystring: z.object({ platform: z.string().max(16).optional() }) },
    },
    async (req) => {
      const a = req.admin!;
      const code = req.query.platform;
      let leadsQb = consentBase(a);
      if (code) leadsQb = leadsQb.where("platforms.code", "=", code);
      const [leads] = await leadsQb
        .select([
          sql<number>`count(*) FILTER (WHERE leads.consent_status = 'awaiting_recording')::int`.as(
            "awaiting",
          ),
          sql<number>`count(*) FILTER (WHERE leads.consent_status = 'overdue')::int`.as("overdue"),
          sql<number>`count(*) FILTER (WHERE leads.consent_status = 'matched')::int`.as("matched"),
        ])
        .execute();
      let recs = db
        .selectFrom("consent_recordings as r")
        .innerJoin("platforms as rp", "rp.id", "r.platform_id");
      let tj = db
        .selectFrom("transfer_jobs as t")
        .innerJoin("platforms as p", "p.id", "t.platform_id");
      if (code) {
        recs = recs.where("rp.code", "=", code);
        tj = tj.where("p.code", "=", code);
      }
      if (a.platformId) {
        recs = recs.where("r.platform_id", "=", a.platformId);
        tj = tj.where("t.platform_id", "=", a.platformId);
      }
      if (a.organisationId) {
        recs = recs.where("r.organisation_id", "=", a.organisationId);
        tj = tj.where("p.organisation_id", "=", a.organisationId);
      }
      const [r2] = await recs
        .select([
          sql<number>`count(*) FILTER (WHERE r.status = 'unmatched')::int`.as("unmatched"),
          sql<number>`count(*) FILTER (WHERE r.status = 'rejected')::int`.as("rejected"),
        ])
        .execute();
      const [t2] = await tj
        .select(
          sql<number>`count(*) FILTER (WHERE t.status = 'failed')::int`.as("failed_transfers"),
        )
        .execute();
      return { ...leads, ...r2, ...t2 };
    },
  );

  r.get(
    "/consent",
    { preHandler: requirePermission("recordings.read"), schema: { querystring: consentFilter } },
    async (req) => {
      const q = req.query;
      let qb = consentBase(req.admin!);
      if (q.view === "needs_recording")
        qb = qb.where("leads.consent_status", "in", ["awaiting_recording", "overdue"]);
      if (q.view === "overdue") qb = qb.where("leads.consent_status", "=", "overdue");
      if (q.view === "matched") qb = qb.where("leads.consent_status", "=", "matched");
      if (q.platform) qb = qb.where("platforms.code", "=", q.platform);
      if (q.q)
        qb = qb.where((eb) =>
          eb.or([
            eb("leads.lead_ref", "=", q.q!.toUpperCase()),
            eb("leads.external_lead_id", "=", q.q!),
            eb("leads.recording_ref", "=", q.q!),
          ]),
        );
      const [{ total }] = (await qb.select(sql<number>`count(*)::int`.as("total")).execute()) as [
        { total: number },
      ];
      const rows = await qb
        .select([
          "leads.id",
          "leads.lead_ref",
          "leads.external_lead_id",
          "leads.first_name",
          "leads.last_name",
          "platforms.code as platform",
          "leads.received_at",
          "leads.verbal_consent",
          "leads.consent_status",
          "leads.recording_ref",
          "leads.status",
          sql<number>`(SELECT count(*)::int FROM consent_recordings c WHERE c.lead_id = leads.id AND c.status = 'matched')`.as(
            "recordings",
          ),
          sql<Date | null>`(SELECT min(created_at) FROM consent_recordings c WHERE c.lead_id = leads.id)`.as(
            "first_recording_at",
          ),
          sql<Date | null>`(SELECT max(matched_at) FROM consent_recordings c WHERE c.lead_id = leads.id)`.as(
            "matched_at",
          ),
          sql<Date | null>`(SELECT max(created_at) FROM lead_events e WHERE e.lead_id = leads.id AND e.type = 'consent_status_synced')`.as(
            "synced_at",
          ),
        ])
        .orderBy("leads.received_at", "desc")
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute();
      const items = rows.map((l) => {
        const steps = consentWorkflow({ ...l, delivered: l.status === "delivered" });
        const current = steps.find((s) => s.state !== "done" && s.state !== "not_applicable");
        return {
          lead_ref: l.lead_ref,
          external_lead_id: l.external_lead_id,
          name: `${l.first_name} ${l.last_name}`,
          platform: l.platform,
          received_at: l.received_at,
          consent_status: l.consent_status,
          recording_ref: l.recording_ref,
          recordings: l.recordings,
          stage: current
            ? { key: current.key, label: current.label, state: current.state }
            : { key: "completed", label: "Transfer completed", state: "done" },
          steps_done: steps.filter((s) => s.state === "done").length,
        };
      });
      return { items, total, page: q.page, pageSize: q.pageSize };
    },
  );
}
