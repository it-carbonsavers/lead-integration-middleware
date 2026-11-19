"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BarChart3, Users } from "lucide-react";
import { api } from "@/lib/api";
import { isProvider, useMe } from "@/lib/me";
import type { Options } from "@/lib/types";
import {
  BarList,
  Card,
  ChartSkeleton,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  Segmented,
  Select,
  StatCard,
  StatCardsSkeleton,
  Table,
  TableSkeleton,
  Td,
  Th,
  useLoad,
} from "@/components/ui";

interface Totals {
  leads: number;
  delivered: number;
  failed: number;
  pending: number;
  possible_duplicates: number;
  consent_captured: number;
  recordings_matched: number;
  avg_delivery_seconds: number | null;
  rejected_submissions: number;
  duplicate_submissions: number;
  delivery_rate_pct: number | null;
  consent_rate_pct: number | null;
}
interface Summary {
  range: { timezone: string };
  totals: Totals;
  by_consent: Record<string, number>;
  drilldown: string;
}
interface Row {
  leads: number;
  delivered: number;
  failed: number;
  pending: number;
  consent_captured: number;
  delivery_rate_pct: number | null;
  consent_rate_pct: number | null;
  drilldown: string;
}
interface PlatformRow extends Row {
  platform: string;
  platform_name: string;
  period_start?: string;
  period_end?: string;
  rejected_submissions: number | null;
}
interface AgentRow extends Row {
  agent_id: string;
  external_agent_id: string;
  agent_name: string | null;
  platform: string;
}

const p = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function View() {
  const me = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const preset = params.get("period") ?? "30";
  const from = params.get("from") ?? iso(new Date(Date.now() - (Number(preset) - 1) * 86_400_000));
  const to = params.get("to") ?? iso(new Date());
  const platform = params.get("platform") ?? "";
  const by = params.get("by") ?? "none";
  const qs = new URLSearchParams({ from, to, ...(platform ? { platform } : {}) }).toString();
  const options = useLoad(() => api.get<Options>("/options"), []);
  const summary = useLoad(() => api.get<Summary>(`/reports/summary?${qs}`), [qs]);
  const sources = useLoad(
    () => api.get<{ items: PlatformRow[] }>(`/reports/platforms?${qs}&groupBy=${by}`),
    [qs, by],
  );
  const agents = useLoad(() => api.get<{ items: AgentRow[] }>(`/reports/agents?${qs}`), [qs]);
  const set = (changes: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    router.push(`/reports?${sp.toString()}`);
  };
  const t = summary.data?.totals;
  const leadsQs = summary.data?.drilldown ?? qs;
  const consent = summary.data?.by_consent ?? {};
  const awaiting = (consent["awaiting_recording"] ?? 0) + (consent["overdue"] ?? 0);

  return (
    <>
      <PageHeader
        title="Reports"
        description="Lead volumes, delivery and consent recordings for the selected period. Click any number to see the leads behind it."
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Segmented
          value={params.get("from") ? "custom" : preset}
          onChange={(v) =>
            v === "custom"
              ? set({ from, to, period: null })
              : set({ period: v, from: null, to: null })
          }
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
            { value: "custom", label: "Custom" },
          ]}
        />
        {params.get("from") && (
          <>
            <Input
              className="w-40"
              type="date"
              value={from}
              onChange={(e) => set({ from: e.target.value })}
              aria-label="From"
            />
            <Input
              className="w-40"
              type="date"
              value={to}
              onChange={(e) => set({ to: e.target.value })}
              aria-label="To"
            />
          </>
        )}
        {!isProvider(me) && (
          <Select
            className="w-52"
            value={platform}
            onChange={(e) => set({ platform: e.target.value || null })}
            aria-label="Source"
            disabled={!options.data}
          >
            <option value="">{options.data ? "All sources" : "Loading sources…"}</option>
            {options.data?.sources.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <ErrorBanner error={summary.error ?? sources.error ?? agents.error} />

      <h2 className="mb-3 text-sm font-semibold text-slate-900">Submissions and delivery</h2>
      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {!t ? (
          summary.error ? null : (
            <StatCardsSkeleton />
          )
        ) : (
          <>
            <StatCard
              label="Leads received"
              value={t.leads.toLocaleString()}
              loading={summary.refreshing}
              href={`/leads?${leadsQs}`}
              hint={`${t.rejected_submissions} rejected submissions`}
            />
            <StatCard
              label="Delivered"
              value={p(t.delivery_rate_pct)}
              hint={`${t.delivered.toLocaleString()} leads`}
              tone="emerald"
              loading={summary.refreshing}
              href={`/leads?${leadsQs}&group=delivered`}
            />
            <StatCard
              label="Failed"
              value={t.failed.toLocaleString()}
              hint={`${t.pending} still pending`}
              tone={t.failed ? "red" : "slate"}
              loading={summary.refreshing}
              href={`/leads?${leadsQs}&group=failed`}
            />
            <StatCard
              label="Average time to deliver"
              value={t.avg_delivery_seconds === null ? "—" : `${t.avg_delivery_seconds}s`}
              hint={`${t.possible_duplicates} possible duplicates`}
              loading={summary.refreshing}
            />
          </>
        )}
      </div>

      <div className="mb-8 grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Lead volume by source"
          padded={false}
          actions={
            <Segmented
              value={by}
              onChange={(v) => set({ by: v === "none" ? null : v })}
              options={[
                { value: "none", label: "Total" },
                { value: "week", label: "By week" },
              ]}
            />
          }
        >
          {!sources.data || (sources.loading && sources.data.items.length === 0) ? (
            sources.error && !sources.data ? null : (
              <TableSkeleton cols={5} rows={4} />
            )
          ) : sources.data.items.length === 0 ? (
            <EmptyState icon={BarChart3} title="No leads in this period" />
          ) : (
            <Table
              loading={sources.loading}
              head={
                <tr>
                  <Th>Source</Th>
                  {by !== "none" && <Th>Week of</Th>}
                  <Th className="text-right">Leads</Th>
                  <Th className="text-right">Delivered</Th>
                  <Th className="text-right">Failed</Th>
                  <Th className="text-right">Consent captured</Th>
                </tr>
              }
            >
              {sources.data.items.map((r) => (
                <tr key={r.platform + (r.period_start ?? "")} className="hover:bg-slate-50">
                  <Td>
                    <div className="font-medium text-slate-900">{r.platform_name}</div>
                    <div className="text-xs text-slate-500">{r.platform}</div>
                  </Td>
                  {by !== "none" && <Td className="text-slate-500">{r.period_start}</Td>}
                  <Td className="text-right">
                    <Link
                      className="font-medium tabular-nums hover:underline"
                      href={`/leads?${r.drilldown}`}
                    >
                      {r.leads.toLocaleString()}
                    </Link>
                  </Td>
                  <Td className="text-right tabular-nums">{p(r.delivery_rate_pct)}</Td>
                  <Td className="text-right tabular-nums">
                    {r.failed ? (
                      <Link
                        className="text-red-600 hover:underline"
                        href={`/leads?${r.drilldown}&group=failed`}
                      >
                        {r.failed}
                      </Link>
                    ) : (
                      0
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{p(r.consent_rate_pct)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card
          title="Consent recordings"
          description="For leads in this period"
          loading={summary.refreshing}
        >
          {!t ? (
            summary.error ? null : (
              <ChartSkeleton />
            )
          ) : (
            <BarList
              items={[
                {
                  label: "Verbal consent captured",
                  value: t.consent_captured,
                  sub: `${p(t.consent_rate_pct)} of leads`,
                },
                {
                  label: "Recording matched",
                  value: t.recordings_matched,
                  href: `/leads?${leadsQs}&consent=matched`,
                },
                {
                  label: "Still waiting for recording",
                  value: awaiting,
                  href: `/leads?${leadsQs}&consent=awaiting_recording`,
                },
                {
                  label: "Overdue",
                  value: consent["overdue"] ?? 0,
                  href: `/leads?${leadsQs}&consent=overdue`,
                },
              ]}
            />
          )}
        </Card>
      </div>

      <Card title="Agent performance" padded={false}>
        {!agents.data || (agents.loading && agents.data.items.length === 0) ? (
          agents.error && !agents.data ? null : (
            <TableSkeleton cols={6} rows={5} />
          )
        ) : agents.data.items.length === 0 ? (
          <EmptyState icon={Users} title="No agent activity in this period" />
        ) : (
          <Table
            loading={agents.loading}
            head={
              <tr>
                <Th>Agent</Th>
                <Th>Source</Th>
                <Th className="text-right">Leads</Th>
                <Th className="text-right">Delivered</Th>
                <Th className="text-right">Failed</Th>
                <Th className="text-right">Consent captured</Th>
              </tr>
            }
          >
            {agents.data.items.map((a) => (
              <tr key={a.agent_id} className="hover:bg-slate-50">
                <Td>
                  <div className="font-medium text-slate-900">
                    {a.agent_name ?? a.external_agent_id}
                  </div>
                  <div className="text-xs text-slate-500">{a.external_agent_id}</div>
                </Td>
                <Td>{a.platform}</Td>
                <Td className="text-right">
                  <Link
                    className="font-medium tabular-nums hover:underline"
                    href={`/leads?${a.drilldown}`}
                  >
                    {a.leads}
                  </Link>
                </Td>
                <Td className="text-right tabular-nums">{p(a.delivery_rate_pct)}</Td>
                <Td className="text-right tabular-nums">{a.failed}</Td>
                <Td className="text-right tabular-nums">{p(a.consent_rate_pct)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {summary.data && (
        <p className="mt-4 text-xs text-slate-500">
          Dates use the {summary.data.range.timezone} time zone.
        </p>
      )}
    </>
  );
}

export default function ReportsPage() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
