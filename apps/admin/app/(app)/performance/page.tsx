"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Trophy } from "lucide-react";
import { api } from "@/lib/api";
import { can, useMe } from "@/lib/me";
import type { Options } from "@/lib/types";
import {
  BarList,
  Card,
  ChartSkeleton,
  EmptyState,
  ErrorBanner,
  Input,
  Notice,
  PageHeader,
  Segmented,
  Select,
  StatCard,
  StatCardsSkeleton,
  Table,
  TableSkeleton,
  Td,
  Th,
  fmtDate,
  useLoad,
} from "@/components/ui";

interface Funnel {
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
  contact_rate_pct: number | null;
  conversion_rate_pct: number | null;
  proposal_to_sale_pct: number | null;
  value_per_lead: number | null;
  value_coverage_pct: number | null;
}
interface Summary {
  range: { timezone: string };
  totals: Funnel;
  by_outcome: Record<string, number>;
  lost_reasons: { reason: string; n: number }[];
  disqualification_reasons: { reason: string; n: number }[];
  campaigns: string[];
  sync: { enabled: boolean; last_run_at: string | null; deals_unreadable: string | null };
}
interface ProviderRow extends Funnel {
  platform: string;
  platform_name: string;
  drilldown: string;
}

const OUTCOME_LABEL: Record<string, string> = {
  sold: "Sold",
  lost: "Proposal rejected / lost",
  disqualified: "Disqualified",
  proposal_sent: "Proposal sent",
  interested: "Interested (deal created)",
  contacted: "Contacted",
  attempting: "Calling, not reached yet",
  new: "Not called yet",
  missing: "Removed from HubSpot",
  not_tracked: "No outcome yet",
};

const p = (v: number | null) => (v === null ? "—" : `${v}%`);
const money = (v: number | null) =>
  v === null
    ? "—"
    : v.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const iso = (d: Date) => d.toISOString().slice(0, 10);

function View() {
  const me = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const preset = params.get("period") ?? "90";
  const from = params.get("from") ?? iso(new Date(Date.now() - (Number(preset) - 1) * 86_400_000));
  const to = params.get("to") ?? iso(new Date());
  const platform = params.get("platform") ?? "";
  const campaign = params.get("campaign") ?? "";
  const outcome = params.get("outcome") ?? "";
  const sort = params.get("sort") ?? "conversion";
  const qs = new URLSearchParams({
    from,
    to,
    ...(platform ? { platform } : {}),
    ...(campaign ? { campaign } : {}),
    ...(outcome ? { outcome } : {}),
  }).toString();

  const options = useLoad(() => api.get<Options>("/options"), []);
  const summary = useLoad(() => api.get<Summary>(`/performance/summary?${qs}`), [qs]);
  const providers = useLoad(
    () => api.get<{ items: ProviderRow[] }>(`/performance/providers?${qs}`),
    [qs],
  );
  const set = (changes: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    router.push(`/performance?${sp.toString()}`);
  };

  const t = summary.data?.totals;
  const sync = summary.data?.sync;
  const sorted = [...(providers.data?.items ?? [])].sort((a, b) =>
    sort === "value"
      ? (b.value_per_lead ?? -1) - (a.value_per_lead ?? -1)
      : sort === "volume"
        ? b.received - a.received
        : (b.conversion_rate_pct ?? -1) - (a.conversion_rate_pct ?? -1),
  );
  const step = (n: number) =>
    t && t.received ? `${Math.round((n / t.received) * 100)}% of leads` : undefined;

  return (
    <>
      <PageHeader
        title="Performance"
        description="What happened to delivered leads in HubSpot: calls, interest, proposals and sales, by the date each lead was received."
        actions={
          can(me, "leads.export") && t && t.received > 0 ? (
            <a
              href={`/admin-api/performance/export.csv?${qs}`}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <Download className="h-4 w-4" /> Export CSV
            </a>
          ) : null
        }
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
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
            { value: "180", label: "180 days" },
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
        <Select
          className="w-48"
          value={campaign}
          onChange={(e) => set({ campaign: e.target.value || null })}
          aria-label="Campaign"
        >
          <option value="">All campaigns</option>
          {summary.data?.campaigns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Select
          className="w-52"
          value={outcome}
          onChange={(e) => set({ outcome: e.target.value || null })}
          aria-label="Outcome"
        >
          <option value="">All outcomes</option>
          {Object.entries(OUTCOME_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>

      {sync && !sync.enabled && (
        <Notice tone="info">
          Outcomes are not being read from HubSpot: the outcome sync is switched off in this
          environment (OUTCOME_SYNC_ENABLED on the worker), so the figures below stay empty.
        </Notice>
      )}
      {sync?.deals_unreadable && (
        <Notice tone="warning">
          HubSpot did not allow deals to be read ({sync.deals_unreadable}). Lead stages and calls
          are shown; proposals, sales and values are missing until the HubSpot key can read deals.
        </Notice>
      )}
      <ErrorBanner error={summary.error ?? providers.error} />

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {!t ? (
          summary.error ? null : (
            <StatCardsSkeleton />
          )
        ) : (
          <>
            <StatCard
              label="Leads delivered"
              value={t.received.toLocaleString()}
              hint={`${t.tracked.toLocaleString()} with an outcome from HubSpot`}
              loading={summary.refreshing}
            />
            <StatCard
              label="Contacted"
              value={p(t.contact_rate_pct)}
              hint={`${t.contacted.toLocaleString()} leads reached`}
              tone="sky"
              loading={summary.refreshing}
            />
            <StatCard
              label="Sold"
              value={t.sold.toLocaleString()}
              hint={`${p(t.conversion_rate_pct)} of leads · ${p(t.proposal_to_sale_pct)} of proposals`}
              tone="emerald"
              loading={summary.refreshing}
            />
            <StatCard
              label="Sale value"
              value={money(t.sale_value)}
              hint={`${money(t.value_per_lead)} per lead · value on ${p(t.value_coverage_pct)} of sales`}
              loading={summary.refreshing}
            />
          </>
        )}
      </div>

      <div className="mb-8 grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Funnel"
          description="Each step counts every lead that reached it or went further"
          loading={summary.refreshing}
        >
          {!t ? (
            summary.error ? null : (
              <ChartSkeleton rows={6} />
            )
          ) : (
            <BarList
              items={[
                { label: "Delivered", value: t.received },
                { label: "Called", value: t.called, sub: step(t.called) },
                { label: "Contacted", value: t.contacted, sub: step(t.contacted) },
                {
                  label: "Interested (deal created)",
                  value: t.interested,
                  sub: step(t.interested),
                },
                { label: "Proposal sent", value: t.proposal_sent, sub: step(t.proposal_sent) },
                { label: "Sold", value: t.sold, sub: step(t.sold) },
              ]}
            />
          )}
        </Card>
        <Card title="Where leads are now" loading={summary.refreshing}>
          {!summary.data ? (
            summary.error ? null : (
              <ChartSkeleton rows={6} />
            )
          ) : (
            <BarList
              items={Object.entries(summary.data.by_outcome)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => ({
                  label: OUTCOME_LABEL[k] ?? k,
                  value: n,
                  href: `/performance?${new URLSearchParams({ ...Object.fromEntries(params), outcome: k }).toString()}`,
                }))}
            />
          )}
          {summary.data && Object.values(summary.data.by_outcome).every((n) => n === 0) && (
            <p className="text-sm text-slate-500">No delivered leads in this period.</p>
          )}
        </Card>
      </div>

      <Card
        className="mb-8"
        title="Compare sources"
        padded={false}
        loading={providers.loading && !!providers.data}
        actions={
          <Segmented
            value={sort}
            onChange={(v) => set({ sort: v === "conversion" ? null : v })}
            options={[
              { value: "conversion", label: "Conversion" },
              { value: "value", label: "Value per lead" },
              { value: "volume", label: "Volume" },
            ]}
          />
        }
      >
        {!providers.data ? (
          providers.error ? null : (
            <TableSkeleton cols={8} rows={4} />
          )
        ) : sorted.length === 0 ? (
          <EmptyState icon={Trophy} title="No delivered leads in this period" />
        ) : (
          <Table
            head={
              <tr>
                <Th>Source</Th>
                <Th className="text-right">Delivered</Th>
                <Th className="text-right">Contacted</Th>
                <Th className="text-right">Interested</Th>
                <Th className="text-right">Proposals</Th>
                <Th className="text-right">Sold</Th>
                <Th className="text-right">Conversion</Th>
                <Th className="text-right">Sale value</Th>
                <Th className="text-right">Per lead</Th>
              </tr>
            }
          >
            {sorted.map((r) => (
              <tr key={r.platform} className="hover:bg-slate-50">
                <Td>
                  <div className="font-medium text-slate-900">{r.platform_name}</div>
                  <div className="text-xs text-slate-500">{r.platform}</div>
                </Td>
                <Td className="text-right">
                  <Link
                    className="font-medium tabular-nums hover:underline"
                    href={`/leads?${r.drilldown}`}
                  >
                    {r.received.toLocaleString()}
                  </Link>
                </Td>
                <Td className="text-right tabular-nums">{p(r.contact_rate_pct)}</Td>
                <Td className="text-right tabular-nums">{r.interested}</Td>
                <Td className="text-right tabular-nums">{r.proposal_sent}</Td>
                <Td className="text-right tabular-nums">{r.sold}</Td>
                <Td className="text-right font-medium tabular-nums">{p(r.conversion_rate_pct)}</Td>
                <Td className="text-right tabular-nums">{money(r.sale_value)}</Td>
                <Td className="text-right tabular-nums">{money(r.value_per_lead)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Why proposals were rejected" description="Lost deals by reason">
          {!summary.data ? (
            summary.error ? null : (
              <ChartSkeleton />
            )
          ) : summary.data.lost_reasons.length === 0 ? (
            <p className="text-sm text-slate-500">No lost deals in this period.</p>
          ) : (
            <BarList
              items={summary.data.lost_reasons.map((r) => ({ label: r.reason, value: r.n }))}
            />
          )}
        </Card>
        <Card title="Why leads were disqualified" description="Disqualified leads by reason">
          {!summary.data ? (
            summary.error ? null : (
              <ChartSkeleton />
            )
          ) : summary.data.disqualification_reasons.length === 0 ? (
            <p className="text-sm text-slate-500">No disqualified leads in this period.</p>
          ) : (
            <BarList
              items={summary.data.disqualification_reasons.map((r) => ({
                label: r.reason,
                value: r.n,
              }))}
            />
          )}
        </Card>
      </div>

      {summary.data && (
        <p className="mt-4 text-xs text-slate-500">
          Dates use the {summary.data.range.timezone} time zone. A sale is a deal that reached an
          Assessments or Installations pipeline; its value is the quote total, or the deal amount
          when there is no quote total.
          {sync?.last_run_at ? ` Last read from HubSpot ${fmtDate(sync.last_run_at)}.` : ""}
        </p>
      )}
    </>
  );
}

export default function PerformancePage() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
