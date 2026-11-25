"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileAudio,
  FileX,
  RefreshCw,
  ServerCrash,
  Upload,
} from "lucide-react";
import { api, type Paged } from "@/lib/api";
import { can, isProvider, isStaff, useMe } from "@/lib/me";
import type { Options } from "@/lib/types";
import { UploadRecordings } from "@/components/upload-recordings";
import { LeadPicker, useSourceLeads } from "@/components/lead-picker";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  fmtDate,
  Notice,
  PageHeader,
  Pagination,
  Segmented,
  Select,
  StatCard,
  StatusPill,
  StepDots,
  Table,
  StatCardsSkeleton,
  TableSkeleton,
  TextButton,
  Tabs,
  Td,
  Th,
  timeAgo,
  useLoad,
} from "@/components/ui";

interface Summary {
  awaiting: number;
  overdue: number;
  matched: number;
  unmatched: number;
  rejected: number;
  failed_transfers: number;
}
interface ConsentLead {
  lead_ref: string;
  external_lead_id: string;
  name: string;
  platform: string;
  received_at: string;
  consent_status: string;
  recording_ref: string | null;
  recordings: number;
  stage: { key: string; label: string; state: string };
  steps_done: number;
}
interface Recording {
  id: string;
  created_at: string;
  platform: string;
  original_filename: string;
  status: string;
  rejection_reason: string | null;
  size_bytes: string;
  matched_by: string | null;
  lead_ref: string | null;
}
interface Transfer {
  id: string;
  started_at: string;
  platform: string;
  mode: string;
  remote_path: string;
  remote_size: string;
  status: string;
  attempts: number;
  error_code: string | null;
  lead_ref: string | null;
}

const REASON: Record<string, string> = {
  content_does_not_match_type: "The file is not real audio of the stated type",
  file_too_large: "The file is larger than allowed",
  invalid_file_name_or_type: "File name or type not accepted",
  empty_file: "The file is empty",
  processing_error: "Could not be processed; will be retried",
};
const MATCHED_BY: Record<string, string> = {
  recording_ref: "recording reference",
  naming_convention: "file name",
  external_lead_id: "source reference",
  admin: "manual link",
  uploader: "lead chosen at upload",
};
const kb = (b: string) => `${Math.max(1, Math.round(Number(b) / 1024))} KB`;

function useQ() {
  const params = useSearchParams();
  const router = useRouter();
  const set = (changes: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    if (!("page" in changes)) sp.delete("page");
    router.push(`/consent?${sp.toString()}`);
  };
  return { params, set };
}

function SourceFilter() {
  const me = useMe();
  const { params, set } = useQ();
  const options = useLoad(() => api.get<Options>("/options"), []);
  if (isProvider(me)) return null;
  return (
    <Select
      className="w-56"
      value={params.get("platform") ?? ""}
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
  );
}

function LeadsTab() {
  const { params, set } = useQ();
  const view = params.get("view") ?? "needs_recording";
  const page = Number(params.get("page") ?? "1");
  const qs = new URLSearchParams({
    view,
    page: String(page),
    pageSize: "20",
    ...(params.get("platform") ? { platform: params.get("platform")! } : {}),
  }).toString();
  const { data, error, loading, reload } = useLoad(
    () => api.get<Paged<ConsentLead>>(`/consent?${qs}`),
    [qs],
  );
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <Segmented
          value={view}
          onChange={(v) => set({ view: v })}
          options={[
            { value: "needs_recording", label: "Waiting for recording" },
            { value: "overdue", label: "Overdue" },
            { value: "matched", label: "Matched" },
            { value: "all", label: "All" },
          ]}
        />
        <SourceFilter />
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {!data || (loading && data.items.length === 0) ? (
        error && !data ? null : (
          <TableSkeleton cols={5} rows={8} />
        )
      ) : !data.items.length ? (
        <EmptyState
          icon={CheckCircle2}
          title={
            view === "needs_recording" ? "No leads are waiting for a recording" : "Nothing here"
          }
          text={
            view === "needs_recording"
              ? "Every lead with verbal consent has its recording."
              : undefined
          }
        />
      ) : (
        <Table
          loading={loading}
          head={
            <tr>
              <Th>Lead</Th>
              <Th>Source</Th>
              <Th>Progress</Th>
              <Th>Expected file</Th>
              <Th className="text-right">Lead received</Th>
            </tr>
          }
        >
          {data.items.map((l) => (
            <tr key={l.lead_ref} className="hover:bg-slate-50">
              <Td>
                <Link
                  className="font-medium text-slate-900 hover:underline"
                  href={`/leads/${l.lead_ref}`}
                >
                  {l.name}
                </Link>
                <div className="text-xs text-slate-500">{l.lead_ref}</div>
              </Td>
              <Td>{l.platform}</Td>
              <Td>
                <div className="flex flex-col gap-1">
                  <StepDots done={l.steps_done} problem={l.stage.state === "problem"} />
                  <span
                    className={
                      l.stage.state === "problem"
                        ? "text-xs text-red-600"
                        : "text-xs text-slate-600"
                    }
                  >
                    {l.stage.state === "done"
                      ? "Completed"
                      : l.stage.state === "problem"
                        ? "Recording overdue"
                        : `Next: ${l.stage.label.toLowerCase()}`}
                  </span>
                </div>
              </Td>
              <Td className="font-mono text-xs text-slate-600">
                {l.recording_ref ?? l.external_lead_id}
              </Td>
              <Td className="whitespace-nowrap text-right text-slate-500">
                {timeAgo(l.received_at)}
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
          loading={loading}
        />
      )}
    </Card>
  );
}

function LinkToLead({
  id,
  platform,
  onDone,
}: {
  id: string;
  platform: string;
  onDone: () => Promise<void>;
}) {
  const me = useMe();
  // Providers only ever see their own leads; staff see the recording's source.
  const leads = useSourceLeads(isProvider(me) ? null : platform);
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <div className="w-72 max-w-full">
        <LeadPicker
          leads={leads.data}
          failed={Boolean(leads.error)}
          onRetry={() => void leads.reload()}
          value={ref}
          onChange={setRef}
          emptyLabel="Choose the lead for this recording…"
        />
      </div>
      <Button
        size="sm"
        disabled={!ref}
        onClick={async () => {
          setError(null);
          try {
            await api.post(`/recordings/${id}/link`, { lead_ref: ref });
            await onDone();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        Link
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

function FilesTab({ onChanged }: { onChanged: () => Promise<void> }) {
  const me = useMe();
  const { params, set } = useQ();
  const status = params.get("status") ?? "";
  const page = Number(params.get("page") ?? "1");
  const qs = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    ...(status ? { status } : {}),
    ...(params.get("platform") ? { platform: params.get("platform")! } : {}),
  }).toString();
  const { data, error, loading, reload } = useLoad(
    () => api.get<Paged<Recording>>(`/recordings?${qs}`),
    [qs],
  );
  const [playing, setPlaying] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <Segmented
          value={status}
          onChange={(v) => set({ status: v || null })}
          options={[
            { value: "", label: "All" },
            { value: "matched", label: "Matched" },
            { value: "unmatched", label: "Not matched" },
            { value: "rejected", label: "Rejected" },
          ]}
        />
        <SourceFilter />
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {!data || (loading && data.items.length === 0) ? (
        error && !data ? null : (
          <TableSkeleton cols={5} rows={8} />
        )
      ) : !data.items.length ? (
        <EmptyState
          icon={FileAudio}
          title="No recording files"
          text="Files appear here once sources deliver them over SFTP."
        />
      ) : (
        <Table
          loading={loading}
          head={
            <tr>
              <Th>File</Th>
              <Th>Source</Th>
              <Th>Status</Th>
              <Th>Lead</Th>
              <Th className="text-right">Received</Th>
            </tr>
          }
        >
          {data.items.map((r) => (
            <tr key={r.id} className="align-top">
              <Td>
                <div className="font-medium text-slate-900">{r.original_filename}</div>
                <div className="text-xs text-slate-500">{kb(r.size_bytes)}</div>
                {playing === r.id && (
                  <audio
                    className="mt-2 w-64"
                    controls
                    autoPlay
                    src={`/admin-api/recordings/${r.id}/audio`}
                  />
                )}
                <div className="mt-1 flex gap-3">
                  {can(me, "recordings.play") &&
                    (r.status === "matched" || r.status === "unmatched") && (
                      <TextButton onClick={() => setPlaying(playing === r.id ? null : r.id)}>
                        {playing === r.id ? "Hide player" : "Play"}
                      </TextButton>
                    )}
                  {can(me, "recordings.link") && r.status === "unmatched" && (
                    <TextButton onClick={() => setLinking(linking === r.id ? null : r.id)}>
                      {linking === r.id ? "Cancel linking" : "Link to a lead"}
                    </TextButton>
                  )}
                </div>
                {linking === r.id && (
                  <LinkToLead
                    id={r.id}
                    platform={r.platform}
                    onDone={async () => {
                      // the summary cards (waiting, not matched) change too
                      await Promise.all([reload(), onChanged()]);
                      setLinking(null);
                    }}
                  />
                )}
              </Td>
              <Td>{r.platform}</Td>
              <Td>
                <StatusPill status={r.status} />
                {r.rejection_reason && (
                  <div className="mt-1 text-xs text-red-600">
                    {REASON[r.rejection_reason] ?? r.rejection_reason}
                  </div>
                )}
                {r.matched_by && (
                  <div className="mt-1 text-xs text-slate-500">
                    Matched by {MATCHED_BY[r.matched_by] ?? r.matched_by}
                  </div>
                )}
              </Td>
              <Td>
                {r.lead_ref ? (
                  <Link className="text-sm hover:underline" href={`/leads/${r.lead_ref}`}>
                    {r.lead_ref}
                  </Link>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </Td>
              <Td className="whitespace-nowrap text-right text-slate-500">
                {timeAgo(r.created_at)}
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
          loading={loading}
        />
      )}
    </Card>
  );
}

function TransfersTab() {
  const me = useMe();
  const { params, set } = useQ();
  const status = params.get("status") ?? "";
  const page = Number(params.get("page") ?? "1");
  const qs = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    ...(status ? { status } : {}),
    ...(params.get("platform") ? { platform: params.get("platform")! } : {}),
  }).toString();
  const { data, error, loading, reload } = useLoad(
    () => api.get<Paged<Transfer>>(`/transfers?${qs}`),
    [qs],
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const canManage = isStaff(me) && can(me, "platforms.manage");
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <Segmented
          value={status}
          onChange={(v) => set({ status: v || null })}
          options={[
            { value: "", label: "All" },
            { value: "stored", label: "Completed" },
            { value: "failed", label: "Failed" },
            { value: "rejected", label: "Rejected" },
          ]}
        />
        <div className="flex items-center gap-2">
          <SourceFilter />
          {canManage && (
            <Button
              variant="secondary"
              icon={RefreshCw}
              onClick={async () => {
                try {
                  await api.post(
                    "/transfers/scan",
                    params.get("platform") ? { platform: params.get("platform") } : {},
                  );
                  setNotice("Checking all sources for new files. Refresh in a few seconds.");
                } catch (e) {
                  setActionError(e);
                }
              }}
            >
              Check for new files
            </Button>
          )}
        </div>
      </div>
      <div className="px-4 pt-4">
        <ErrorBanner error={error ?? actionError} onRetry={reload} />
        {notice && (
          <Notice tone="success" onClose={() => setNotice(null)}>
            {notice}
          </Notice>
        )}
      </div>
      {!data || (loading && data.items.length === 0) ? (
        error && !data ? null : (
          <TableSkeleton cols={6} rows={8} />
        )
      ) : !data.items.length ? (
        <EmptyState icon={FileAudio} title="No file transfers yet" />
      ) : (
        <Table
          loading={loading}
          head={
            <tr>
              <Th>File</Th>
              <Th>Source</Th>
              <Th>How it arrived</Th>
              <Th>Result</Th>
              <Th>Lead</Th>
              <Th className="text-right">When</Th>
            </tr>
          }
        >
          {data.items.map((x) => (
            <tr key={x.id}>
              <Td>
                <div className="font-mono text-xs text-slate-800">
                  {x.remote_path.replace(/^\//, "")}
                </div>
                <div className="text-xs text-slate-500">
                  {kb(x.remote_size)}
                  {x.attempts > 1 && ` · ${x.attempts} attempts`}
                </div>
              </Td>
              <Td>{x.platform}</Td>
              <Td className="text-slate-600">{TRANSFER_SOURCE[x.mode] ?? x.mode}</Td>
              <Td>
                <StatusPill status={x.status} />
                {x.error_code && (
                  <div className="mt-1 text-xs text-red-600">
                    {REASON[x.error_code] ?? x.error_code.replace(/_/g, " ")}
                  </div>
                )}
                {x.status === "failed" && canManage && (
                  <TextButton
                    className="mt-1"
                    onClick={async () => {
                      try {
                        await api.post(`/transfers/${x.id}/retry`);
                        setNotice("Retry queued.");
                        setTimeout(reload, 4000);
                      } catch (e) {
                        setActionError(e);
                      }
                    }}
                  >
                    Retry
                  </TextButton>
                )}
              </Td>
              <Td>
                {x.lead_ref ? (
                  <Link className="hover:underline" href={`/leads/${x.lead_ref}`}>
                    {x.lead_ref}
                  </Link>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </Td>
              <Td className="whitespace-nowrap text-right text-slate-500">
                <span title={fmtDate(x.started_at)}>{timeAgo(x.started_at)}</span>
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
          loading={loading}
        />
      )}
    </Card>
  );
}

/** How a file reached us (transfer_jobs.mode). */
const TRANSFER_SOURCE: Record<string, string> = {
  sftp_hosted: "SFTP upload",
  portal_upload: "Portal upload",
  sftp_pull: "Collected from provider (old)",
};

function View() {
  const me = useMe();
  const [uploading, setUploading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const params = useSearchParams();
  const tab = params.get("tab") ?? "leads";
  const platform = params.get("platform");
  const summary = useLoad(
    () => api.get<Summary>(`/consent/summary${platform ? `?platform=${platform}` : ""}`),
    [platform],
  );
  const s = summary.data;
  const base = params.get("platform") ? `&platform=${params.get("platform")}` : "";
  return (
    <>
      <PageHeader
        title="Consent Recordings"
        description="Verbal-consent recordings from lead sources: what is waiting, what has arrived, and any transfer problems."
        actions={
          can(me, "recordings.upload") ? (
            <Button icon={Upload} onClick={() => setUploading(true)}>
              Upload recordings
            </Button>
          ) : undefined
        }
      />
      {uploading && (
        <UploadRecordings
          onClose={() => setUploading(false)}
          onDone={() => {
            void summary.reload();
            setRefresh((x) => x + 1);
          }}
        />
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {!s ? (
          <StatCardsSkeleton />
        ) : (
          <>
            <StatCard
              label="Waiting for recording"
              value={s.awaiting + s.overdue}
              icon={Clock}
              tone="amber"
              loading={summary.refreshing}
              href="/consent?view=needs_recording"
            />
            <StatCard
              label="Overdue"
              value={s.overdue}
              icon={AlertTriangle}
              tone="red"
              hint="Not received within 48 hours"
              loading={summary.refreshing}
              href="/consent?view=overdue"
            />
            <StatCard
              label="Files not matched"
              value={s.unmatched + s.rejected}
              icon={FileX}
              tone="amber"
              hint="Unmatched or rejected files"
              loading={summary.refreshing}
              href="/consent?tab=files&status=unmatched"
            />
            <StatCard
              label="Failed transfers"
              value={s.failed_transfers}
              icon={ServerCrash}
              tone={s.failed_transfers ? "red" : "slate"}
              loading={summary.refreshing}
              href="/consent?tab=transfers&status=failed"
            />
          </>
        )}
      </div>
      <Tabs
        active={tab}
        tabs={[
          { key: "leads", label: "Leads", href: `/consent?tab=leads${base}` },
          { key: "files", label: "Recording files", href: `/consent?tab=files${base}` },
          { key: "transfers", label: "Transfer history", href: `/consent?tab=transfers${base}` },
        ]}
      />
      {tab === "leads" && <LeadsTab key={`l${refresh}`} />}
      {tab === "files" && <FilesTab key={`f${refresh}`} onChanged={summary.reload} />}
      {tab === "transfers" && <TransfersTab key={`t${refresh}`} />}
    </>
  );
}

export default function ConsentPage() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
