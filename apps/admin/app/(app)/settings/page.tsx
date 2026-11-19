"use client";

import Link from "next/link";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import {
  Button,
  Card,
  CardSkeleton,
  ErrorBanner,
  fmtDate,
  Skeleton,
  StatusPill,
  Table,
  TableSkeleton,
  Td,
  Th,
  timeAgo,
  useLoad,
} from "@/components/ui";

interface ScanResult {
  platform: string;
  seen: number;
  stored: number;
  rejected: number;
  failed?: number;
  error?: string;
}
interface SystemStatus {
  checked_at: string;
  services: {
    database: { ok: boolean; migrations_current: boolean };
    worker: { ok: boolean; last_seen_at: string | null };
    hubspot: { enabled: boolean };
    recording_storage: { configured: boolean };
    sftp: { configured: boolean; host: string | null; port: number | null };
  };
  queues: { name: string; queued: number; active: number; deferred: number; failed: number }[];
  attention: Record<string, number>;
  last_recordings_scan: { last_seen_at: string; detail: { results?: ScanResult[] } } | null;
  last_retention_run: { last_seen_at: string; detail: Record<string, number> } | null;
}

const QUEUE_LABEL: Record<string, string> = {
  "deliver-lead": "Lead deliveries",
  "sync-consent": "Consent updates to CRM",
  "recordings-scan": "Recording pick-ups",
  "dead-letter": "Gave up after retries",
};

function Service({ name, ok, text }: { name: string; ok: boolean; text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      {ok ? (
        <CheckCircle2 className="h-5 w-5 text-emerald-600" />
      ) : (
        <XCircle className="h-5 w-5 text-red-600" />
      )}
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-900">{name}</div>
        <div className="truncate text-xs text-slate-500">{text}</div>
      </div>
    </div>
  );
}

export default function SystemHealthPage() {
  const { data, error, refreshing, reload } = useLoad(
    () => api.get<SystemStatus>("/system"),
    [],
  );
  if (error && !data) return <ErrorBanner error={error} onRetry={reload} />;
  if (!data)
    return (
      <div className="space-y-6">
        <CardSkeleton>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))}
          </div>
        </CardSkeleton>
        <CardSkeleton>
          <Skeleton className="h-4 w-48" />
        </CardSkeleton>
        <div className="grid gap-6 xl:grid-cols-2">
          <CardSkeleton>
            <TableSkeleton cols={4} rows={4} />
          </CardSkeleton>
          <CardSkeleton />
        </div>
      </div>
    );
  const s = data.services;
  const a = data.attention;
  const issues = [
    {
      n: (a.failed ?? 0) + (a.dead_letter ?? 0),
      label: "failed lead deliveries",
      href: "/leads?group=failed",
    },
    {
      n: a.consent_overdue ?? 0,
      label: "overdue consent recordings",
      href: "/consent?view=overdue",
    },
    {
      n: a.unmatched ?? 0,
      label: "recording files not matched",
      href: "/consent?tab=files&status=unmatched",
    },
    {
      n: a.rejected_submissions_24h ?? 0,
      label: "rejected submissions in 24 h",
      href: "/leads?tab=submissions",
    },
  ].filter((i) => i.n > 0);

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} onRetry={reload} />
      <Card
        title="Services"
        description={`Checked ${fmtDate(data.checked_at)}`}
        loading={refreshing}
        actions={
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={reload}>
            Refresh
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Service
            name="Database"
            ok={s.database.ok && s.database.migrations_current}
            text={s.database.migrations_current ? "Up to date" : "Updates pending"}
          />
          <Service
            name="Background worker"
            ok={s.worker.ok}
            text={
              s.worker.last_seen_at ? `Active ${timeAgo(s.worker.last_seen_at)}` : "Not running"
            }
          />
          <Service
            name="Recording storage"
            ok={s.recording_storage.configured}
            text={s.recording_storage.configured ? "Encrypted storage ready" : "Not configured"}
          />
          <Service
            name="SFTP server"
            ok={s.sftp.configured}
            text={
              s.sftp.configured
                ? `${s.sftp.host}:${s.sftp.port}`
                : "Not connected (SFTPGo runs on Railway)"
            }
          />
          <Service
            name="CRM delivery"
            ok
            text={s.hubspot.enabled ? "HubSpot enabled" : "Test destination (HubSpot off)"}
          />
        </div>
      </Card>

      <Card title="Needs attention" loading={refreshing}>
        {issues.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> Nothing needs attention.
          </p>
        ) : (
          <ul className="space-y-2">
            {issues.map((i) => (
              <li key={i.label}>
                <Link
                  href={i.href}
                  className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-slate-50"
                >
                  <span className="text-slate-700">
                    <span className="font-semibold text-slate-900">{i.n}</span> {i.label}
                  </span>
                  <span className="text-xs font-medium text-emerald-700">View</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Background jobs" padded={false}>
          <Table
            loading={refreshing}
            head={
              <tr>
                <Th>Job</Th>
                <Th className="text-right">Waiting</Th>
                <Th className="text-right">Running</Th>
                <Th className="text-right">Failed</Th>
              </tr>
            }
          >
            {data.queues.map((q) => (
              <tr key={q.name}>
                <Td>{QUEUE_LABEL[q.name] ?? q.name}</Td>
                <Td className="text-right tabular-nums">{q.queued + q.deferred}</Td>
                <Td className="text-right tabular-nums">{q.active}</Td>
                <Td className={`text-right tabular-nums ${q.failed ? "text-red-600" : ""}`}>
                  {q.failed}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card
          title="Last recording pick-up"
          description={
            data.last_recordings_scan ? timeAgo(data.last_recordings_scan.last_seen_at) : "Not yet"
          }
        >
          <ul className="space-y-2">
            {(data.last_recordings_scan?.detail.results ?? []).map((r) => (
              <li key={r.platform} className="flex items-center justify-between text-sm">
                <span className="text-slate-700">{r.platform} · SFTP upload</span>
                {r.error ? (
                  <StatusPill label="Problem" tone="red" />
                ) : (
                  <span className="text-xs text-slate-500">{r.stored} new file(s)</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-slate-500">
            Data retention last ran{" "}
            {data.last_retention_run
              ? timeAgo(data.last_retention_run.last_seen_at)
              : "never (daily at 03:15)"}
            .
          </p>
        </Card>
      </div>
    </div>
  );
}
