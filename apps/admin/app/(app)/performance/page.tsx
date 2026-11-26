"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Trophy, X } from "lucide-react";
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
  Pagination,
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
    router.push(`/performance?${sp.toString()}`, { scroll: false });
  };

  // Drill-down: which leads to list under the summary (d_* params, kept separate from the
  // page filters so the numbers above do not change when a list is opened).
  const drill = {
    step: params.get("d_step") ?? "",
    outcome: params.get("d_outcome") ?? "",
    lost: params.get("d_lost"),
    dq: params.get("d_dq"),
    source: params.get("d_source") ?? "",
  };
  const drillOpen = !!(
    drill.step ||
    drill.outcome ||
    drill.lost !== null ||
    drill.dq !== null ||
    drill.source
  );
  const drillHref = (d: Record<string, string>) => {
    const sp = new URLSearchParams(params.toString());
    for (const k of ["d_step", "d_outcome", "d_lost", "d_dq", "d_source", "d_page"]) sp.delete(k);
    for (const [k, v] of Object.entries(d)) sp.set(`d_${k}`, v);
    return `/performance?${sp.toString()}`;
  };
  const sourceName = (code: string) =>
    providers.data?.items.find((x) => x.platform === code)?.platform_name ?? code;
  const drillTitle = [
    drill.step && STEP_LABEL[drill.step],
    drill.outcome && `Now: ${OUTCOME_LABEL[drill.outcome] ?? drill.outcome}`,
    drill.lost !== null && `Lost: ${drill.lost}`,
    drill.dq !== null && `Disqualified: ${drill.dq}`,
    drill.source && sourceName(drill.source),
  ]
    .filter(Boolean)
    .join(" · ");

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
                { label: "Delivered", value: t.received, href: drillHref({ step: "all" }) },
                {
                  label: "Called",
                  value: t.called,
                  sub: step(t.called),
                  href: drillHref({ step: "called" }),
                },
                {
                  label: "Contacted",
                  value: t.contacted,
                  sub: step(t.contacted),
                  href: drillHref({ step: "contacted" }),
                },
                {
                  label: "Interested (deal created)",
                  value: t.interested,
                  sub: step(t.interested),
                  href: drillHref({ step: "interested" }),
                },
                {
                  label: "Proposal sent",
                  value: t.proposal_sent,
                  sub: step(t.proposal_sent),
                  href: drillHref({ step: "proposal_sent" }),
                },
                {
                  label: "Sold",
                  value: t.sold,
                  sub: step(t.sold),
                  href: drillHref({ step: "sold" }),
                },
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
                  href: drillHref({ outcome: k }),
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
                  <CountLink href={drillHref({ source: r.platform, step: "all" })}>
                    {r.received.toLocaleString()}
                  </CountLink>
                </Td>
                <Td className="text-right">
                  <CountLink href={drillHref({ source: r.platform, step: "contacted" })}>
                    {p(r.contact_rate_pct)}
                  </CountLink>
                </Td>
                <Td className="text-right">
                  <CountLink href={drillHref({ source: r.platform, step: "interested" })}>
                    {r.interested}
                  </CountLink>
                </Td>
                <Td className="text-right">
                  <CountLink href={drillHref({ source: r.platform, step: "proposal_sent" })}>
                    {r.proposal_sent}
                  </CountLink>
                </Td>
                <Td className="text-right">
                  <CountLink href={drillHref({ source: r.platform, step: "sold" })}>
                    {r.sold}
                  </CountLink>
                </Td>
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
              items={summary.data.lost_reasons.map((r) => ({
                label: r.reason,
                value: r.n,
                href: drillHref({ lost: r.reason }),
              }))}
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
                href: drillHref({ dq: r.reason }),
              }))}
            />
          )}
        </Card>
      </div>

      {drillOpen && (
        <LeadList
          filterQs={qs}
          drill={drill}
          title={drillTitle}
          page={Number(params.get("d_page") ?? "1")}
          onPage={(n) => set({ d_page: n > 1 ? String(n) : null })}
          onClose={() =>
            set({
              d_step: null,
              d_outcome: null,
              d_lost: null,
              d_dq: null,
              d_source: null,
              d_page: null,
            })
          }
        />
      )}

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

const STEP_LABEL: Record<string, string> = {
  all: "All delivered leads",
  called: "Called",
  contacted: "Contacted",
  interested: "Interested (deal created)",
  proposal_sent: "Proposal sent",
  sold: "Sold",
};

function CountLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} scroll={false} className="font-medium tabular-nums hover:underline">
      {children}
    </Link>
  );
}

interface PerfLead {
  lead_ref: string;
  name: string;
  platform: string;
  platform_name: string;
  campaign: string | null;
  received_at: string;
  outcome: string;
  lead_stage: string | null;
  deal_pipeline: string | null;
  deal_stage: string | null;
  proposal_sent_at: string | null;
  lost_reason: string | null;
  disqualification_reason: string | null;
  sold_at: string | null;
  sale_value: number | null;
}

/** The leads behind a number on the page, opened by clicking it. */
function LeadList({
  filterQs,
  drill,
  title,
  page,
  onPage,
  onClose,
}: {
  filterQs: string;
  drill: { step: string; outcome: string; lost: string | null; dq: string | null; source: string };
  title: string;
  page: number;
  onPage: (n: number) => void;
  onClose: () => void;
}) {
  const sp = new URLSearchParams(filterQs);
  if (drill.step && drill.step !== "all") sp.set("step", drill.step);
  if (drill.outcome) sp.set("outcome", drill.outcome);
  if (drill.lost !== null) sp.set("lost_reason", drill.lost);
  if (drill.dq !== null) sp.set("dq_reason", drill.dq);
  if (drill.source) sp.set("platform", drill.source);
  sp.set("page", String(page));
  const apiQs = sp.toString();
  const list = useLoad(
    () =>
      api.get<{ items: PerfLead[]; total: number; page: number; pageSize: number }>(
        `/performance/leads?${apiQs}`,
      ),
    [apiQs],
  );
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [title]);

  return (
    <div ref={ref} className="mt-8 scroll-mt-6">
      <Card
        title={`Leads: ${title}`}
        description={list.data ? `${list.data.total.toLocaleString()} leads` : undefined}
        padded={false}
        loading={list.loading && !!list.data}
        actions={
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
            aria-label="Close the list"
          >
            <X className="h-4 w-4" />
          </button>
        }
      >
        <ErrorBanner error={list.error} />
        {!list.data ? (
          list.error ? null : (
            <TableSkeleton cols={6} rows={5} />
          )
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={Trophy} title="No leads" />
        ) : (
          <>
            <Table
              head={
                <tr>
                  <Th>Lead</Th>
                  <Th>Source</Th>
                  <Th>Received</Th>
                  <Th>Where it is now</Th>
                  <Th>In HubSpot</Th>
                  <Th>Reason</Th>
                  <Th className="text-right">Sale value</Th>
                </tr>
              }
            >
              {list.data.items.map((l) => (
                <tr key={l.lead_ref} className="hover:bg-slate-50">
                  <Td>
                    <Link
                      href={`/leads/${l.lead_ref}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {l.name || l.lead_ref}
                    </Link>
                    <div className="text-xs text-slate-500">{l.lead_ref}</div>
                  </Td>
                  <Td>
                    <div>{l.platform_name}</div>
                    {l.campaign && <div className="text-xs text-slate-500">{l.campaign}</div>}
                  </Td>
                  <Td className="whitespace-nowrap text-slate-600">
                    {fmtDate(l.received_at, false)}
                  </Td>
                  <Td>
                    <div>{OUTCOME_LABEL[l.outcome] ?? l.outcome}</div>
                    {l.proposal_sent_at && (
                      <div className="text-xs text-slate-500">
                        Proposal {fmtDate(l.proposal_sent_at, false)}
                      </div>
                    )}
                    {l.sold_at && (
                      <div className="text-xs text-slate-500">Sold {fmtDate(l.sold_at, false)}</div>
                    )}
                  </Td>
                  <Td>
                    <div>{l.deal_stage ?? l.lead_stage ?? "—"}</div>
                    {l.deal_pipeline && (
                      <div className="text-xs text-slate-500">{l.deal_pipeline}</div>
                    )}
                  </Td>
                  <Td className="text-slate-600">
                    {l.lost_reason ?? l.disqualification_reason ?? "—"}
                  </Td>
                  <Td className="text-right tabular-nums">{money(l.sale_value)}</Td>
                </tr>
              ))}
            </Table>
            <Pagination
              page={list.data.page}
              pageSize={list.data.pageSize}
              total={list.data.total}
              onPage={onPage}
              loading={list.loading}
            />
          </>
        )}
      </Card>
    </div>
  );
}

export default function PerformancePage() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
