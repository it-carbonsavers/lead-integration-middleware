"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileAudio, Inbox, Users } from "lucide-react";
import { api } from "@/lib/api";
import { isProvider, useMe } from "@/lib/me";
import type { Overview } from "@/lib/types";
import {
  BarList,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  pct,
  Segmented,
  Skeleton,
  StatCard,
  StatusPill,
  Table,
  Td,
  Th,
  timeAgo,
  useLoad,
} from "@/components/ui";

const PERIODS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;

export default function OverviewPage() {
  const me = useMe();
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const { data, error, loading, reload } = useLoad(
    () => api.get<Overview>(`/overview?days=${days}`),
    [days],
  );
  const t = data?.totals;
  const since = new Date(Date.now() - Number(days) * 86_400_000).toISOString().slice(0, 10);
  const leadsLink = (extra = "") => `/leads?from=${since}${extra}`;
  const firstName = (me.name ?? "").split(" ")[0];

  return (
    <>
      <PageHeader
        title={isProvider(me) ? `Welcome${firstName ? `, ${firstName}` : ""}` : "Overview"}
        description={
          isProvider(me)
            ? "Your leads and consent recordings at a glance."
            : "How leads and consent recordings are flowing."
        }
        actions={<Segmented value={days} options={[...PERIODS]} onChange={setDays} />}
      />
      <ErrorBanner error={error} onRetry={reload} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading && !t ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-32 rounded-2xl" />)
        ) : t ? (
          <>
            <StatCard
              label="Leads received"
              value={t.received.toLocaleString()}
              icon={Inbox}
              tone="sky"
              hint={`Last ${days} days`}
              href={leadsLink()}
            />
            <StatCard
              label="Delivered"
              value={t.delivered.toLocaleString()}
              icon={CheckCircle2}
              tone="emerald"
              hint={`${pct(t.delivered, t.received)} of leads`}
              href={leadsLink("&group=delivered")}
            />
            <StatCard
              label="Pending"
              value={t.pending.toLocaleString()}
              icon={Clock}
              tone="amber"
              hint="Processing or retrying"
              href={leadsLink("&group=pending")}
            />
            <StatCard
              label="Failed"
              value={t.failed.toLocaleString()}
              icon={AlertTriangle}
              tone="red"
              hint={t.failed ? "Need attention" : "Nothing to fix"}
              href={leadsLink("&group=failed")}
            />
          </>
        ) : null}
      </div>

      {t && (
        <Link
          href="/consent"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition hover:border-slate-300"
        >
          <div className="flex items-center gap-3">
            <span className="rounded-lg bg-amber-50 p-2 text-amber-600">
              <FileAudio className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-medium text-slate-900">Consent recordings pending</div>
              <div className="text-xs text-slate-500">
                Leads with verbal consent still waiting for their recording
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold text-slate-900">{t.consent_pending}</span>
            {t.consent_overdue > 0 && (
              <StatusPill status="overdue" label={`${t.consent_overdue} overdue`} />
            )}
          </div>
        </Link>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Leads by source" description={`Last ${days} days`}>
          {loading && !data ? (
            <Skeleton className="h-40" />
          ) : data?.by_source.length ? (
            <BarList
              items={data.by_source.map((s) => ({
                label: `${s.display_name} (${s.code})`,
                value: s.leads,
                href: leadsLink(`&platform=${s.code}`),
              }))}
            />
          ) : (
            <EmptyState
              title="No leads in this period"
              text="Leads appear here as soon as a source sends them."
            />
          )}
        </Card>

        <Card title="Leads by agent" description="Top agents in this period" padded={false}>
          {loading && !data ? (
            <div className="p-5">
              <Skeleton className="h-40" />
            </div>
          ) : data?.by_agent.length ? (
            <Table
              head={
                <tr>
                  <Th>Agent</Th>
                  <Th>Source</Th>
                  <Th className="text-right">Leads</Th>
                  <Th className="text-right">Delivered</Th>
                </tr>
              }
            >
              {data.by_agent.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <Td>
                    <Link
                      className="font-medium text-slate-900 hover:underline"
                      href={leadsLink(`&agent=${a.id}`)}
                    >
                      {a.name ?? a.external_agent_id}
                    </Link>
                    <div className="text-xs text-slate-500">{a.external_agent_id}</div>
                  </Td>
                  <Td>{a.code}</Td>
                  <Td className="text-right tabular-nums">{a.leads}</Td>
                  <Td className="text-right tabular-nums">{pct(a.delivered, a.leads)}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState icon={Users} title="No agent activity yet" />
          )}
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Latest leads"
        padded={false}
        actions={
          <Link href="/leads" className="text-sm font-medium text-emerald-700 hover:underline">
            View all
          </Link>
        }
      >
        {data?.recent.length ? (
          <Table
            head={
              <tr>
                <Th>Customer</Th>
                <Th>Source</Th>
                <Th>Delivery</Th>
                <Th>Consent recording</Th>
                <Th className="text-right">Received</Th>
              </tr>
            }
          >
            {data.recent.map((l) => (
              <tr key={l.lead_ref} className="hover:bg-slate-50">
                <Td>
                  <Link
                    href={`/leads/${l.lead_ref}`}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {l.first_name} {l.last_name}
                  </Link>
                </Td>
                <Td>{l.code}</Td>
                <Td>
                  <StatusPill status={l.status} />
                </Td>
                <Td>
                  <StatusPill status={l.consent_status} />
                </Td>
                <Td className="text-right text-slate-500">{timeAgo(l.received_at)}</Td>
              </tr>
            ))}
          </Table>
        ) : loading ? (
          <div className="p-5">
            <Skeleton className="h-32" />
          </div>
        ) : (
          <EmptyState
            title="No leads yet"
            text="As soon as a lead source sends a lead, it shows up here."
          />
        )}
      </Card>
    </>
  );
}
