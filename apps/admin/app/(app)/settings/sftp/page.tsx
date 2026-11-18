"use client";

import Link from "next/link";
import { api } from "@/lib/api";
import { RecordingHealth, type Source } from "@/components/sources";
import {
  Card,
  CopyValue,
  KeyValue,
  Notice,
  Skeleton,
  Table,
  Td,
  Th,
  timeAgo,
  useLoad,
} from "@/components/ui";

export default function SftpSettingsPage() {
  const sources = useLoad(() => api.get<{ items: Source[] }>("/platforms"), []);
  const first = sources.data?.items.find((s) => s.recording_ingest_mode === "sftp_hosted");
  const server = useLoad(
    () =>
      first
        ? api.get<{
            our_server: {
              server: string | null;
              host: string | null;
              port: number | null;
              host_key_fingerprint: string | null;
              max_file_mb: number;
            };
          }>(`/platforms/${first.code}/sftp`)
        : Promise.resolve(null),
    [first?.code],
  );
  return (
    <div className="space-y-6">
      <Notice tone="info">
        Lead sources <strong>upload consent recordings to our SFTP server</strong>, each into its
        own private, upload-only folder. New files are picked up every minute, matched to their
        leads and stored encrypted.
      </Notice>
      <Card
        title="Our SFTP server"
        description="Each source has its own account and private, upload-only folder."
      >
        {server.data ? (
          <div className="space-y-3">
            <KeyValue
              items={[
                {
                  label: "Address",
                  value: (
                    <code className="text-xs">
                      {server.data.our_server.host ?? "not connected"}
                    </code>
                  ),
                },
                {
                  label: "Port",
                  value: <code className="text-xs">{server.data.our_server.port ?? "–"}</code>,
                },
                {
                  label: "Login",
                  value: "Per-source username with SSH key (recommended) or generated password",
                },
                {
                  label: "Server",
                  value: server.data.our_server.server
                    ? `${server.data.our_server.server} (Railway)`
                    : "No SFTP server connected in this environment (see docs/RAILWAY_DEPLOYMENT.md)",
                },
                { label: "Largest file", value: `${server.data.our_server.max_file_mb} MB` },
              ]}
            />
            {server.data.our_server.host_key_fingerprint && (
              <div>
                <div className="mb-1 text-xs text-slate-500">
                  Server fingerprint (give this to providers)
                </div>
                <CopyValue value={server.data.our_server.host_key_fingerprint} />
              </div>
            )}
          </div>
        ) : sources.loading ? (
          <Skeleton className="h-24" />
        ) : (
          <p className="text-sm text-slate-500">No source is set up for recordings yet.</p>
        )}
      </Card>
      <Card
        title="Sources"
        description="Open a source to change its login, issue a new password or test the connection."
        padded={false}
      >
        <Table
          head={
            <tr>
              <Th>Source</Th>
              <Th>Status</Th>
              <Th className="text-right">Last successful connection</Th>
            </tr>
          }
        >
          {sources.data?.items.map((s) => (
            <tr key={s.code} className="hover:bg-slate-50">
              <Td>
                <Link
                  className="font-medium text-slate-900 hover:underline"
                  href={`/sources/${s.code}?tab=recordings`}
                >
                  {s.display_name}
                </Link>
                <div className="text-xs text-slate-500">{s.code}</div>
              </Td>
              <Td>
                <RecordingHealth s={s} />
              </Td>
              <Td className="text-right text-slate-500">
                {s.recording_ingest_mode === "none" ? "—" : timeAgo(s.sftp_last_success_at)}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
