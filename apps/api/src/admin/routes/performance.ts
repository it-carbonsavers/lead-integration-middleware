/**
 * Lead performance: what happened to leads after delivery (from lead_outcomes, filled by the
 * read-only sync-outcomes job). Lead provider users see the same report for their own source
 * only (every query goes through scopeLeads), including sale values, which their payment is based
 * on; the comparison across sources is staff only.
 *
 *   GET /performance/summary      funnel totals, outcome and lost-reason breakdowns, sync status
 *   GET /performance/providers    the funnel per source, for comparison
 *   GET /performance/leads        the leads behind any number on the page (paged)
 *   GET /performance/export.csv   one row per lead (no personal data), audited
 *
 * Funnel stages are cumulative: a sold lead also counts as contacted, interested and proposal
 * sent. The stage and outcome rules below are provisional until the HubSpot specialist confirms
 * the mapping (design doc, open question 6).
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql, type SelectQueryBuilder } from "kysely";
import { z } from "zod";
import { problems } from "@lim/core";
import { writeAudit, type Database } from "@lim/db";
import { requirePermission, type AdminContext } from "../auth.js";
import {
  applyLeadFilters,
  baseLeadQuery,
  filterToQuery,
  isProviderUser,
  leadFilterSchema,
} from "../lead-query.js";
import type { AdminRouteOptions } from "./index.js";

const OUTCOMES = [
  "sold",
  "lost",
  "disqualified",
  "proposal_sent",
  "interested",
  "contacted",
  "attempting",
  "new",
  "missing",
  "not_tracked",
] as const;
type Outcome = (typeof OUTCOMES)[number];

const performanceQuery = leadFilterSchema.pick({ from: true, to: true, platform: true }).extend({
  campaign: z.string().trim().max(200).optional(),
  outcome: z.enum(OUTCOMES).optional(),
});
type PerformanceQuery = z.infer<typeof performanceQuery>;

const NO_REASON = "No reason given";
const STEPS = ["called", "contacted", "interested", "proposal_sent", "sold", "lost"] as const;

/** Which leads to list: a funnel step, a lost or disqualification reason (plus the page filters). */
const leadListQuery = performanceQuery.extend({
  step: z.enum(STEPS).optional(),
  lost_reason: z.string().max(300).optional(),
  dq_reason: z.string().max(300).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * lead_outcomes with each deal credited to one lead only. Several leads of the same customer can
 * point to the same HubSpot deal; the deal goes to the lead it is linked to in HubSpot, else to
 * the earliest lead received. The customer's other leads keep their calls and lead stage but not
 * the deal, so it is counted (and its value added) once.
 */
const creditedOutcomes = sql`(
  SELECT x.lead_id, x.hubspot_lead_id, x.missing, x.lead_stage_id, x.lead_stage,
    x.lead_stage_changed_at, x.disqualification_reason, x.calls_attempted, x.calls_connected,
    x.synced_at, x.created_at,
    CASE WHEN x.credited THEN x.deal_count ELSE 0 END AS deal_count,
    CASE WHEN x.credited THEN x.deal_id END AS deal_id,
    CASE WHEN x.credited THEN x.deal_pipeline END AS deal_pipeline,
    CASE WHEN x.credited THEN x.deal_stage END AS deal_stage,
    CASE WHEN x.credited THEN x.deal_created_at END AS deal_created_at,
    CASE WHEN x.credited THEN x.proposal_sent_at END AS proposal_sent_at,
    CASE WHEN x.credited THEN x.proposal_status END AS proposal_status,
    x.credited AND x.lost AS lost,
    CASE WHEN x.credited THEN x.lost_reason END AS lost_reason,
    x.credited AND x.sold AS sold,
    CASE WHEN x.credited THEN x.sold_at END AS sold_at,
    CASE WHEN x.credited THEN x.sale_value END AS sale_value,
    CASE WHEN x.credited THEN x.sale_value_field END AS sale_value_field,
    CASE WHEN x.credited THEN x.quote_value END AS quote_value,
    x.credited AND x.deal_linked AS deal_linked
  FROM (
    SELECT lo.*,
      lo.deal_id IS NULL OR row_number() OVER (
        PARTITION BY lo.deal_id
        ORDER BY lo.deal_linked DESC, cl.received_at ASC, cl.id ASC
      ) = 1 AS credited
    FROM lead_outcomes lo
    JOIN leads cl ON cl.id = lo.lead_id
  ) x
)`;

// --- Stage rules (on alias o = lead_outcomes) -------------------------------------
const qualifiedStage = sql<boolean>`(o.lead_stage ILIKE '%qualified%' AND o.lead_stage NOT ILIKE 'disqualified%')`;
const disqualifiedStage = sql<boolean>`(o.lead_stage_id = 'unqualified-stage-id' OR o.lead_stage ILIKE 'disqualified%')`;
const interested = sql<boolean>`(o.sold OR o.deal_count > 0 OR ${qualifiedStage})`;
const contacted = sql<boolean>`(${interested} OR o.calls_connected > 0
  OR o.lead_stage ILIKE '%connected%' OR o.lead_stage ILIKE '%call-back%' OR o.lead_stage ILIKE '%call back%')`;
const proposal = sql<boolean>`(o.sold OR o.proposal_sent_at IS NOT NULL OR o.deal_stage ILIKE '%proposal sent%')`;

/** One outcome per lead: the furthest point it reached, or why it stopped. */
const outcomeOf = sql<Outcome>`CASE
  WHEN o.lead_id IS NULL THEN 'not_tracked'
  WHEN o.missing THEN 'missing'
  WHEN o.sold THEN 'sold'
  WHEN o.lost THEN 'lost'
  WHEN ${disqualifiedStage} THEN 'disqualified'
  WHEN ${proposal} THEN 'proposal_sent'
  WHEN ${interested} THEN 'interested'
  WHEN ${contacted} THEN 'contacted'
  WHEN o.calls_attempted > 0 OR o.lead_stage ILIKE 'attempt%' THEN 'attempting'
  ELSE 'new'
END`;

const funnel = () => [
  sql<number>`count(*)::int`.as("received"),
  sql<number>`count(o.lead_id) FILTER (WHERE NOT o.missing)::int`.as("tracked"),
  sql<number>`count(*) FILTER (WHERE o.calls_attempted > 0 OR ${contacted})::int`.as("called"),
  sql<number>`count(*) FILTER (WHERE ${contacted})::int`.as("contacted"),
  sql<number>`count(*) FILTER (WHERE ${interested})::int`.as("interested"),
  sql<number>`count(*) FILTER (WHERE ${proposal})::int`.as("proposal_sent"),
  sql<number>`count(*) FILTER (WHERE o.sold)::int`.as("sold"),
  sql<number>`count(*) FILTER (WHERE o.lost)::int`.as("lost"),
  sql<number>`count(*) FILTER (WHERE o.sold AND o.sale_value IS NOT NULL)::int`.as(
    "sold_with_value",
  ),
  sql<number>`coalesce(sum(o.sale_value) FILTER (WHERE o.sold), 0)::float`.as("sale_value"),
  // What was quoted on every proposal sent, and the part still open (not sold, not lost).
  sql<number>`coalesce(sum(o.quote_value) FILTER (WHERE ${proposal}), 0)::float`.as("quoted_value"),
  sql<number>`coalesce(sum(o.quote_value) FILTER (WHERE ${proposal} AND NOT o.sold AND NOT o.lost), 0)::float`.as(
    "open_quote_value",
  ),
];

interface FunnelRow {
  received: number;
  tracked: number;
  called: number;
  contacted: number;
  interested: number;
  proposal_sent: number;
  sold: number;
  lost: number;
  sold_with_value: number;
  sale_value: number;
  quoted_value: number;
  open_quote_value: number;
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const rates = (f: FunnelRow) => ({
  contact_rate_pct: pct(f.contacted, f.received),
  conversion_rate_pct: pct(f.sold, f.received),
  proposal_to_sale_pct: pct(f.sold, f.proposal_sent),
  value_per_lead: f.received ? Math.round((f.sale_value / f.received) * 100) / 100 : null,
  value_coverage_pct: pct(f.sold_with_value, f.sold),
});

type PerfQB = SelectQueryBuilder<
  Database & { o: Database["lead_outcomes"] },
  "leads" | "platforms" | "o",
  object
>;

export async function adminPerformanceRoutes(app: FastifyInstance, opts: AdminRouteOptions) {
  const { db, config } = opts;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tz = config.REPORT_TIMEZONE;

  /** The comparison across sources is for staff; a provider only ever sees its own source. */
  const staffOnly = async (req: { admin?: AdminContext }) => {
    if (req.admin?.platformId) throw problems.forbidden("Not available for lead provider users");
  };
  const pre = [requirePermission("reports.read")];

  const base = (q: PerformanceQuery, admin: AdminContext): PerfQB => {
    let qb = applyLeadFilters(
      baseLeadQuery(db, admin),
      { from: q.from, to: q.to, platform: q.platform, dateField: "received_at", status: [] },
      config,
    ).leftJoin(creditedOutcomes.as("o"), (j) =>
      j.onRef(sql.ref("o.lead_id"), "=", sql.ref("leads.id")),
    ) as unknown as PerfQB;
    // Only leads that went to a destination can have an outcome.
    qb = qb.where("leads.status", "=", "delivered");
    if (q.campaign) qb = qb.where("leads.campaign", "=", q.campaign);
    if (q.outcome) qb = qb.where(outcomeOf, "=", q.outcome);
    return qb;
  };

  const syncStatus = async (provider: boolean) => {
    const s = await db
      .selectFrom("service_status")
      .select(["last_seen_at", "detail"])
      .where("name", "=", "outcome-sync")
      .executeTakeFirst();
    const detail = (s?.detail ?? {}) as { status?: string; dealsUnreadable?: string | null };
    // The sync runs in the worker: its setting (reported on every heartbeat) is what counts.
    const worker = await db
      .selectFrom("service_status")
      .select(sql<boolean | null>`(detail->>'outcome_sync_enabled')::boolean`.as("on"))
      .where("name", "=", "worker")
      .executeTakeFirst();
    return {
      enabled: config.OUTCOME_SYNC_ENABLED || worker?.on === true,
      last_run_at: s?.last_seen_at ?? null,
      // Internal error detail is not shown to provider users.
      deals_unreadable: provider ? null : (detail.dealsUnreadable ?? null),
    };
  };

  r.get(
    "/performance/summary",
    { preHandler: pre, schema: { querystring: performanceQuery } },
    async (req) => {
      const q = req.query;
      const [totals] = await base(q, req.admin!).select(funnel()).execute();
      const byOutcome = await base(q, req.admin!)
        .select([outcomeOf.as("outcome"), sql<number>`count(*)::int`.as("n")])
        .groupBy(sql`1`)
        .execute();
      const lostReasons = await base(q, req.admin!)
        .where("o.lost", "=", true)
        .select([
          sql<string>`coalesce(o.lost_reason, ${NO_REASON})`.as("reason"),
          sql<number>`count(*)::int`.as("n"),
        ])
        .groupBy(sql`1`)
        .orderBy(sql`2`, "desc")
        .limit(10)
        .execute();
      const disqualified = await base(q, req.admin!)
        .where(disqualifiedStage)
        .select([
          sql<string>`coalesce(o.disqualification_reason, ${NO_REASON})`.as("reason"),
          sql<number>`count(*)::int`.as("n"),
        ])
        .groupBy(sql`1`)
        .orderBy(sql`2`, "desc")
        .limit(10)
        .execute();
      const campaigns = await base({ ...q, campaign: undefined, outcome: undefined }, req.admin!)
        .where("leads.campaign", "is not", null)
        .select("leads.campaign")
        .distinct()
        .orderBy("leads.campaign")
        .limit(200)
        .execute();
      const t = totals as FunnelRow;
      return {
        range: { from: q.from ?? null, to: q.to ?? null, timezone: tz },
        totals: { ...t, ...rates(t) },
        by_outcome: Object.fromEntries(
          OUTCOMES.map((o) => [o, byOutcome.find((b) => b.outcome === o)?.n ?? 0]),
        ),
        lost_reasons: lostReasons,
        disqualification_reasons: disqualified,
        campaigns: campaigns.map((c) => c.campaign).filter((c): c is string => !!c),
        sync: await syncStatus(isProviderUser(req.admin!)),
      };
    },
  );

  r.get(
    "/performance/leads",
    {
      preHandler: [requirePermission("reports.read"), requirePermission("leads.read")],
      schema: { querystring: leadListQuery },
    },
    async (req) => {
      const q = req.query;
      let qb = base(q, req.admin!);
      const stepRule = {
        called: sql<boolean>`(o.calls_attempted > 0 OR ${contacted})`,
        contacted,
        interested,
        proposal_sent: proposal,
        sold: sql<boolean>`o.sold`,
        lost: sql<boolean>`o.lost`,
      } as const;
      if (q.step) qb = qb.where(stepRule[q.step]);
      if (q.lost_reason !== undefined) {
        qb = qb.where("o.lost", "=", true);
        qb =
          q.lost_reason === NO_REASON
            ? qb.where("o.lost_reason", "is", null)
            : qb.where("o.lost_reason", "=", q.lost_reason);
      }
      if (q.dq_reason !== undefined) {
        qb = qb.where(disqualifiedStage);
        qb =
          q.dq_reason === NO_REASON
            ? qb.where("o.disqualification_reason", "is", null)
            : qb.where("o.disqualification_reason", "=", q.dq_reason);
      }
      const [count] = await qb.select(sql<number>`count(*)::int`.as("n")).execute();
      const rows = await qb
        .select([
          "leads.lead_ref",
          "leads.first_name",
          "leads.last_name",
          "leads.campaign",
          "leads.received_at",
          "platforms.code as platform",
          "platforms.display_name as platform_name",
          outcomeOf.as("outcome"),
          "o.lead_stage",
          "o.calls_attempted",
          "o.calls_connected",
          "o.disqualification_reason",
          "o.deal_pipeline",
          "o.deal_stage",
          "o.proposal_sent_at",
          "o.lost_reason",
          "o.sold_at",
          "o.sale_value",
          "o.quote_value",
        ])
        .orderBy("leads.received_at", "desc")
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute();
      return {
        items: rows.map((row) => ({
          ...row,
          name: `${row.first_name} ${row.last_name}`.trim(),
          sale_value: row.sale_value === null ? null : Number(row.sale_value),
          quote_value: row.quote_value === null ? null : Number(row.quote_value),
        })),
        total: count?.n ?? 0,
        page: q.page,
        pageSize: q.pageSize,
      };
    },
  );

  r.get(
    "/performance/providers",
    { preHandler: [...pre, staffOnly], schema: { querystring: performanceQuery } },
    async (req) => {
      const q = req.query;
      const rows = await base(q, req.admin!)
        .select([
          "platforms.code as platform",
          "platforms.display_name as platform_name",
          ...funnel(),
        ])
        .groupBy(["platforms.code", "platforms.display_name"])
        .orderBy("platforms.code")
        .execute();
      return {
        items: rows.map((row) => ({
          ...row,
          ...rates(row as FunnelRow),
          drilldown: filterToQuery({ platform: row.platform, from: q.from, to: q.to }),
        })),
      };
    },
  );

  r.get(
    "/performance/export.csv",
    {
      preHandler: [requirePermission("reports.read"), requirePermission("leads.export")],
      schema: { querystring: performanceQuery },
    },
    async (req, reply) => {
      const MAX = 20_000;
      const q = req.query;
      const rows = await base(q, req.admin!)
        .select([
          "leads.lead_ref",
          "platforms.code as platform",
          "leads.campaign",
          sql<string>`to_char(leads.received_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI')`.as(
            "received",
          ),
          outcomeOf.as("outcome"),
          "o.lead_stage",
          "o.calls_attempted",
          "o.calls_connected",
          "o.disqualification_reason",
          "o.deal_pipeline",
          "o.deal_stage",
          sql<string | null>`to_char(o.proposal_sent_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`.as(
            "proposal_sent",
          ),
          "o.lost_reason",
          sql<string | null>`to_char(o.sold_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`.as("sold"),
          "o.sale_value",
          "o.quote_value",
          sql<string | null>`to_char(o.synced_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI')`.as(
            "updated",
          ),
        ])
        .orderBy("leads.received_at", "desc")
        .limit(MAX + 1)
        .execute();
      if (rows.length > MAX)
        throw problems.badRequest(`Export limited to ${MAX} rows; narrow the filters`);

      const header = [
        "lead_ref",
        "source",
        "campaign",
        "received",
        "outcome",
        "lead_stage",
        "calls_attempted",
        "calls_connected",
        "disqualification_reason",
        "deal_pipeline",
        "deal_stage",
        "proposal_sent",
        "lost_reason",
        "sold",
        "sale_value",
        "quote_value",
        "updated_from_hubspot",
      ];
      const lines = [header.join(",")];
      for (const row of rows) {
        lines.push(
          [
            row.lead_ref,
            row.platform,
            row.campaign,
            row.received,
            row.outcome,
            row.lead_stage,
            row.calls_attempted,
            row.calls_connected,
            row.disqualification_reason,
            row.deal_pipeline,
            row.deal_stage,
            row.proposal_sent,
            row.lost_reason,
            row.sold,
            row.sale_value,
            row.quote_value,
            row.updated,
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
        action: "performance.export",
        requestId: req.id,
        ip: req.ip,
        detail: { rows: rows.length, filters: q },
      });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="lead-performance-${stamp}.csv"`)
        .send(lines.join("\r\n") + "\r\n");
    },
  );
}

/** CSV cell with formula-injection protection (values starting = + - @ are prefixed). */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
