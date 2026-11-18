"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Inbox, SearchX, X } from "lucide-react";
import { api, type Paged } from "@/lib/api";
import { can, isProvider, useMe } from "@/lib/me";
import { STATUS_GROUPS, type LeadRow, type Options } from "@/lib/types";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  fmtDate,
  Input,
  PageHeader,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  StatusPill,
  Table,
  TableSkeleton,
  Tabs,
  Td,
  Th,
  timeAgo,
  useLoad,
} from "@/components/ui";

interface Submission {
  id: string;
  received_at: string;
  platform: string;
  outcome: string;
  http_status: number;
  external_lead_id: string | null;
  error_summary: { path: string; code: string }[] | null;
  request_id: string;
  lead_ref: string | null;
}

type Group = "all" | "delivered" | "pending" | "failed";

function useQueryState() {
  const params = useSearchParams();
  const router = useRouter();
  const set = (changes: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    if (!("page" in changes)) sp.delete("page");
    router.push(`/leads?${sp.toString()}`);
  };
  return { params, set };
}

function LeadsTable() {
  const me = useMe();
  const { params, set } = useQueryState();
  const options = useLoad(() => api.get<Options>("/options"), []);
  const [search, setSearch] = useState(params.get("q") ?? "");
  useEffect(() => setSearch(params.get("q") ?? ""), [params]);

  const group = (params.get("group") as Group) ?? "all";
  const page = Number(params.get("page") ?? "1");
  const apiQs = new URLSearchParams();
  for (const k of ["q", "from", "to", "platform", "agent", "consent", "duplicate"]) {
    const v = params.get(k);
    if (v) apiQs.set(k, v);
  }
  if (group !== "all") apiQs.set("status", STATUS_GROUPS[group]!);
  if (params.get("status")) apiQs.set("status", params.get("status")!);
  apiQs.set("page", String(page));
  apiQs.set("pageSize", "20");
  const qs = apiQs.toString();
  const { data, error, loading, reload } = useLoad(
    () => api.get<Paged<LeadRow>>(`/leads?${qs}`),
    [qs],
  );

  const agents = (options.data?.agents ?? []).filter(
    (a) => !params.get("platform") || a.platform === params.get("platform"),
  );
  const active = ["q", "from", "to", "platform", "agent", "consent", "duplicate", "status"].filter(
    (k) => params.get(k),
  );
  const exportQs = new URLSearchParams(qs);
  exportQs.delete("page");
  exportQs.delete("pageSize");

  return (
    <>
      <Card padded={false}>
        <div className="space-y-3 border-b border-slate-100 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <form
              className="min-w-[220px] flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                set({ q: search.trim() || null });
              }}
            >
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search name, lead reference, exact email or phone"
              />
            </form>
            <Segmented<Group>
              value={group}
              onChange={(v) => set({ group: v === "all" ? null : v, status: null })}
              options={[
                { value: "all", label: "All" },
                { value: "delivered", label: "Delivered" },
                { value: "pending", label: "Pending" },
                { value: "failed", label: "Failed" },
              ]}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {!isProvider(me) && (
              <Select
                value={params.get("platform") ?? ""}
                onChange={(e) => set({ platform: e.target.value || null, agent: null })}
                aria-label="Source"
              >
                <option value="">All sources</option>
                {options.data?.sources.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
            <Select
              value={params.get("agent") ?? ""}
              onChange={(e) => set({ agent: e.target.value || null })}
              aria-label="Agent"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ? `${a.name} (${a.external_agent_id})` : a.external_agent_id}
                </option>
              ))}
            </Select>
            <Select
              value={params.get("consent") ?? ""}
              onChange={(e) => set({ consent: e.target.value || null })}
              aria-label="Consent recording"
            >
              <option value="">Any consent status</option>
              <option value="awaiting_recording">Awaiting recording</option>
              <option value="overdue">Recording overdue</option>
              <option value="matched">Recording matched</option>
              <option value="not_captured">No recording needed</option>
            </Select>
            <Input
              type="date"
              value={params.get("from") ?? ""}
              onChange={(e) => set({ from: e.target.value || null })}
              aria-label="From date"
            />
            <Input
              type="date"
              value={params.get("to") ?? ""}
              onChange={(e) => set({ to: e.target.value || null })}
              aria-label="To date"
            />
            <Select
              value={params.get("duplicate") ?? ""}
              onChange={(e) => set({ duplicate: e.target.value || null })}
              aria-label="Duplicates"
            >
              <option value="">Duplicates: any</option>
              <option value="true">Possible duplicates only</option>
            </Select>
          </div>
          {active.length > 0 && (
            <button
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800"
              onClick={() => set(Object.fromEntries([...active, "group"].map((k) => [k, null])))}
            >
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
          )}
        </div>
        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? (
          <TableSkeleton />
        ) : data && data.items.length === 0 ? (
          active.length ? (
            <EmptyState
              icon={SearchX}
              title="No leads match these filters"
              text="Try a wider date range or clear the filters."
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="No leads yet"
              text="Leads appear here as soon as a source sends them."
            />
          )
        ) : (
          <Table
            head={
              <tr>
                <Th>Customer</Th>
                <Th>Source</Th>
                <Th>Agent</Th>
                <Th>Delivery</Th>
                <Th>Consent recording</Th>
                <Th className="text-right">Received</Th>
              </tr>
            }
          >
            {data?.items.map((l) => (
              <tr
                key={l.lead_ref}
                className="group cursor-pointer hover:bg-slate-50"
                onClick={() => (window.location.href = `/leads/${l.lead_ref}`)}
              >
                <Td>
                  <Link
                    href={`/leads/${l.lead_ref}`}
                    className="font-medium text-slate-900 group-hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {l.first_name} {l.last_name}
                  </Link>
                  <div className="text-xs text-slate-500">
                    {l.lead_ref}
                    {l.possible_duplicate && (
                      <span className="ml-2 text-amber-700">· possible duplicate</span>
                    )}
                  </div>
                </Td>
                <Td>{l.platform}</Td>
                <Td className="text-slate-600">{l.agent_name ?? l.agent_external_id ?? "—"}</Td>
                <Td>
                  <StatusPill status={l.status} />
                </Td>
                <Td>
                  <StatusPill status={l.consent_status} />
                </Td>
                <Td className="whitespace-nowrap text-right text-slate-500">
                  <span title={fmtDate(l.received_at)}>{timeAgo(l.received_at)}</span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {data && (
          <Pagination
            page={page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={(p) => set({ page: String(p) })}
          />
        )}
      </Card>
      {can(me, "leads.export") && data && data.total > 0 && (
        <div className="mt-3 flex justify-end">
          <a href={`/admin-api/leads/export.csv?${exportQs.toString()}`}>
            <Button variant="secondary" icon={Download} size="sm">
              Export {data.total.toLocaleString()} leads (CSV)
            </Button>
          </a>
        </div>
      )}
    </>
  );
}

function SubmissionsTable() {
  const { params, set } = useQueryState();
  const outcome = params.get("outcome") ?? "rejected";
  const page = Number(params.get("page") ?? "1");
  const qs = new URLSearchParams({
    pageSize: "20",
    page: String(page),
    ...(outcome !== "all" ? { outcome } : {}),
  }).toString();
  const { data, error, loading, reload } = useLoad(
    () => api.get<Paged<Submission>>(`/submissions?${qs}`),
    [qs],
  );
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <p className="text-sm text-slate-500">
          Every request sources sent, including ones we rejected and why.
        </p>
        <Segmented
          value={outcome}
          onChange={(v) => set({ outcome: v })}
          options={[
            { value: "rejected", label: "Rejected" },
            { value: "duplicate", label: "Duplicates" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? (
        <TableSkeleton />
      ) : data?.items.length === 0 ? (
        <EmptyState
          title={outcome === "rejected" ? "No rejected submissions" : "Nothing here"}
          text="Good news: sources are sending valid leads."
        />
      ) : (
        <Table
          head={
            <tr>
              <Th>Received</Th>
              <Th>Source</Th>
              <Th>Result</Th>
              <Th>Their reference</Th>
              <Th>Why</Th>
            </tr>
          }
        >
          {data?.items.map((s) => (
            <tr key={s.id}>
              <Td className="whitespace-nowrap text-slate-500">{fmtDate(s.received_at)}</Td>
              <Td>{s.platform}</Td>
              <Td>
                <StatusPill status={s.outcome} />
              </Td>
              <Td>
                {s.lead_ref ? (
                  <Link className="hover:underline" href={`/leads/${s.lead_ref}`}>
                    {s.external_lead_id}
                  </Link>
                ) : (
                  (s.external_lead_id ?? "—")
                )}
              </Td>
              <Td className="text-xs text-slate-600">
                {s.error_summary?.length
                  ? s.error_summary
                      .map((e) => `${e.path.replace(/[._]/g, " ")}: ${e.code.replace(/_/g, " ")}`)
                      .join(" · ")
                  : s.outcome === "duplicate"
                    ? "Already received; nothing was sent twice"
                    : "—"}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {data && (
        <Pagination
          page={page}
          pageSize={data.pageSize}
          total={data.total}
          onPage={(p) => set({ page: String(p) })}
        />
      )}
    </Card>
  );
}

function View() {
  const params = useSearchParams();
  const tab = params.get("tab") === "submissions" ? "submissions" : "leads";
  return (
    <>
      <PageHeader
        title="Leads"
        description="Every lead received from your sources, where it was delivered, and its consent recording."
      />
      <Tabs
        active={tab}
        tabs={[
          { key: "leads", label: "All leads", href: "/leads" },
          { key: "submissions", label: "Submission log", href: "/leads?tab=submissions" },
        ]}
      />
      {tab === "leads" ? <LeadsTable /> : <SubmissionsTable />}
    </>
  );
}

export default function LeadsPage() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
