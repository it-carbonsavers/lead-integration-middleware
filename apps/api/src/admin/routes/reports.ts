/**
 * Reporting and analytics. Every report uses the same lead filters as the lead list, and every
 * row carries a `drilldown` query string that opens exactly the leads behind its numbers.
 *
 *   GET /reports/summary     totals for the period
 *   GET /reports/platforms   per source platform (optionally per day/week/month)
 *   GET /reports/agents      per agent
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql, type RawBuilder } from "kysely";
import { z } from "zod";
import { requirePermission, type AdminContext } from "../auth.js";
import {
  applyLeadFilters,
  baseLeadQuery,
  dayEnd,
  dayStart,
  filterToQuery,
  leadFilterSchema,
} from "../lead-query.js";
import type { AdminRouteOptions } from "./index.js";

const reportQuery = leadFilterSchema
  .pick({ from: true, to: true, dateField: true, platform: true })
  .extend({
    groupBy: z.enum(["none", "day", "week", "month"]).default("none"),
  });

const metrics = () => [
  sql<number>`count(*)::int`.as("leads"),
  sql<number>`count(*) FILTER (WHERE leads.status = 'delivered')::int`.as("delivered"),
  sql<number>`count(*) FILTER (WHERE leads.status IN ('failed','dead_letter'))::int`.as("failed"),
  sql<number>`count(*) FILTER (WHERE leads.status IN ('received','queued','delivering','retry_scheduled','held'))::int`.as(
    "pending",
  ),
  sql<number>`count(*) FILTER (WHERE leads.possible_duplicate_of IS NOT NULL)::int`.as(
    "possible_duplicates",
  ),
  sql<number>`count(*) FILTER (WHERE leads.verbal_consent)::int`.as("consent_captured"),
  sql<number>`count(*) FILTER (WHERE leads.consent_status = 'matched')::int`.as(
    "recordings_matched",
  ),
  sql<
    number | null
  >`round((avg(extract(epoch from leads.delivered_at - leads.received_at)) FILTER (WHERE leads.delivered_at IS NOT NULL))::numeric, 1)::float`.as(
    "avg_delivery_seconds",
  ),
];

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

export async function adminReportRoutes(app: FastifyInstance, opts: AdminRouteOptions) {
  const { db, config } = opts;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tz = config.REPORT_TIMEZONE;
  const perm = requirePermission("reports.read");

  const period = (groupBy: "day" | "week" | "month", dateField: string) => {
    const col = sql.ref(`leads.${dateField}`);
    const trunc = sql`date_trunc(${sql.lit(groupBy)}, ${col} AT TIME ZONE ${sql.lit(tz)})`;
    return {
      start: sql<string>`to_char(${trunc}, 'YYYY-MM-DD')`,
      end: sql<string>`to_char(${trunc} + ${sql.lit(`1 ${groupBy}`)}::interval - interval '1 day', 'YYYY-MM-DD')`,
    };
  };

  const rejectedCounts = async (q: z.infer<typeof reportQuery>, admin: AdminContext) => {
    let qb = db
      .selectFrom("submissions as s")
      .innerJoin("platforms as p", "p.id", "s.platform_id")
      .select([
        "p.code as platform",
        sql<number>`count(*) FILTER (WHERE s.outcome = 'rejected')::int`.as("rejected"),
        sql<number>`count(*) FILTER (WHERE s.outcome = 'duplicate')::int`.as(
          "duplicate_submissions",
        ),
      ])
      .groupBy("p.code");
    if (admin.organisationId) qb = qb.where("p.organisation_id", "=", admin.organisationId);
    if (admin.platformId) qb = qb.where("s.platform_id", "=", admin.platformId);
    if (q.platform) qb = qb.where("p.code", "=", q.platform);
    if (q.from) qb = qb.where("s.received_at", ">=", dayStart(q.from, tz));
    if (q.to) qb = qb.where("s.received_at", "<", dayEnd(q.to, tz));
    return qb.execute();
  };

  const filterOf = (q: z.infer<typeof reportQuery>) => ({ ...q, status: [] as never[] });

  r.get(
    "/reports/summary",
    { preHandler: perm, schema: { querystring: reportQuery } },
    async (req) => {
      const q = req.query;
      const [totals] = await applyLeadFilters(baseLeadQuery(db, req.admin!), filterOf(q), config)
        .select(metrics())
        .execute();
      const subs = await rejectedCounts(q, req.admin!);
      const byConsent = await applyLeadFilters(baseLeadQuery(db, req.admin!), filterOf(q), config)
        .select(["leads.consent_status", sql<number>`count(*)::int`.as("n")])
        .groupBy("leads.consent_status")
        .execute();
      const byStatus = await applyLeadFilters(baseLeadQuery(db, req.admin!), filterOf(q), config)
        .select(["leads.status", sql<number>`count(*)::int`.as("n")])
        .groupBy("leads.status")
        .execute();
      const t = totals!;
      return {
        range: { from: q.from ?? null, to: q.to ?? null, dateField: q.dateField, timezone: tz },
        totals: {
          ...t,
          rejected_submissions: subs.reduce((a, s) => a + s.rejected, 0),
          duplicate_submissions: subs.reduce((a, s) => a + s.duplicate_submissions, 0),
          delivery_rate_pct: pct(t.delivered, t.leads),
          consent_rate_pct: pct(t.consent_captured, t.leads),
        },
        by_status: Object.fromEntries(byStatus.map((s) => [s.status, s.n])),
        by_consent: Object.fromEntries(byConsent.map((s) => [s.consent_status, s.n])),
        drilldown: filterToQuery({
          from: q.from,
          to: q.to,
          dateField: q.dateField,
          platform: q.platform,
        }),
      };
    },
  );

  r.get(
    "/reports/platforms",
    { preHandler: perm, schema: { querystring: reportQuery } },
    async (req) => {
      const q = req.query;
      let qb = applyLeadFilters(baseLeadQuery(db, req.admin!), filterOf(q), config).select([
        "platforms.code as platform",
        "platforms.display_name as platform_name",
        ...metrics(),
      ]);
      let groups: (string | RawBuilder<unknown>)[] = ["platforms.code", "platforms.display_name"];
      if (q.groupBy !== "none") {
        const p = period(q.groupBy, q.dateField);
        qb = qb.select([p.start.as("period_start"), p.end.as("period_end")]);
        groups = [...groups, sql`period_start`, sql`period_end`];
      }
      const rows = await qb
        .groupBy(groups as never)
        .orderBy("platforms.code")
        .$if(q.groupBy !== "none", (b) => b.orderBy(sql`period_start`))
        .execute();
      const subs = q.groupBy === "none" ? await rejectedCounts(q, req.admin!) : [];
      return {
        range: {
          from: q.from ?? null,
          to: q.to ?? null,
          dateField: q.dateField,
          timezone: tz,
          groupBy: q.groupBy,
        },
        items: rows.map((row) => {
          const rr = row as typeof row & { period_start?: string; period_end?: string };
          const s = subs.find((x) => x.platform === rr.platform);
          return {
            ...rr,
            rejected_submissions: q.groupBy === "none" ? (s?.rejected ?? 0) : null,
            delivery_rate_pct: pct(rr.delivered, rr.leads),
            consent_rate_pct: pct(rr.consent_captured, rr.leads),
            drilldown: filterToQuery({
              platform: rr.platform,
              from: rr.period_start ?? q.from,
              to: rr.period_end ?? q.to,
              dateField: q.dateField,
            }),
          };
        }),
      };
    },
  );

  r.get(
    "/reports/agents",
    { preHandler: perm, schema: { querystring: reportQuery } },
    async (req) => {
      const q = req.query;
      const rows = await applyLeadFilters(baseLeadQuery(db, req.admin!), filterOf(q), config)
        .innerJoin("agents", "agents.id", "leads.agent_id")
        .select([
          "agents.id as agent_id",
          "agents.external_agent_id",
          "agents.name as agent_name",
          "platforms.code as platform",
          ...metrics(),
        ])
        .groupBy(["agents.id", "agents.external_agent_id", "agents.name", "platforms.code"])
        .orderBy("platforms.code")
        .orderBy(sql`count(*)`, "desc")
        .execute();
      return {
        range: { from: q.from ?? null, to: q.to ?? null, dateField: q.dateField, timezone: tz },
        items: rows.map((row) => ({
          ...row,
          delivery_rate_pct: pct(row.delivered, row.leads),
          consent_rate_pct: pct(row.consent_captured, row.leads),
          drilldown: filterToQuery({
            agent: row.agent_id,
            platform: row.platform,
            from: q.from,
            to: q.to,
            dateField: q.dateField,
          }),
        })),
      };
    },
  );
}
