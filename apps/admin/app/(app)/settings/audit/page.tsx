"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ScrollText } from "lucide-react";
import { api, type Paged } from "@/lib/api";
import {
  Card,
  EmptyState,
  ErrorBanner,
  fmtDate,
  Pagination,
  SearchInput,
  Select,
  Table,
  TableSkeleton,
  Td,
  Th,
  useLoad,
} from "@/components/ui";

interface Entry {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  "admin.login": "Signed in",
  "admin.login_failed": "Failed sign-in",
  "admin.logout": "Signed out",
  "lead.view": "Viewed a lead",
  "lead.search": "Searched leads",
  "lead.pii_reveal": "Showed customer details",
  "lead.export": "Exported leads",
  "lead.retry_requested": "Retried a delivery",
  "recording.played": "Played a recording",
  "recording.linked": "Linked a recording to a lead",
  "platform.created": "Added a lead source",
  "platform.updated": "Changed a lead source",
  "platform.suspended": "Suspended a lead source",
  "platform.activated": "Activated a lead source",
  "platform.credential_issued": "Issued an API key",
  "platform.credential_revoked": "Revoked an API key",
  "platform.sftp_updated": "Changed SFTP settings",
  "platform.sftp_tested": "Tested an SFTP connection",
  "transfer.scan_requested": "Checked for new recordings",
  "transfer.retry_requested": "Retried a file transfer",
  "user.created": "Added a user",
  "user.updated": "Changed a user",
  "user.password_reset": "Reset a password",
  "user.password_changed": "Changed own password",
  "provider_user.created": "Added a partner login",
  "provider_user.updated": "Changed a partner login",
  "provider_user.password_reset": "Reset a partner password",
};

function View() {
  const params = useSearchParams();
  const router = useRouter();
  const [actor, setActor] = useState(params.get("actor") ?? "");
  const page = Number(params.get("page") ?? "1");
  const qs = params.toString();
  const { data, error, loading, reload } = useLoad(
    () => api.get<Paged<Entry>>(`/audit?pageSize=25&${qs}`),
    [qs],
  );
  const set = (k: string, v: string) => {
    const sp = new URLSearchParams(params.toString());
    if (v) sp.set(k, v);
    else sp.delete(k);
    if (k !== "page") sp.delete("page");
    router.push(`/settings/audit?${sp.toString()}`);
  };
  return (
    <Card
      title="Audit log"
      description="A permanent record of sign-ins, views of customer data, exports and configuration changes. It cannot be edited."
      padded={false}
    >
      <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set("actor", actor.trim());
          }}
        >
          <SearchInput value={actor} onChange={setActor} placeholder="Filter by person (email)" />
        </form>
        <Select value={params.get("action") ?? ""} onChange={(e) => set("action", e.target.value)}>
          <option value="">All activity</option>
          <option value="admin.">Sign-ins</option>
          <option value="lead.">Lead access and exports</option>
          <option value="recording.">Recordings</option>
          <option value="platform.">Lead source changes</option>
          <option value="user.">User changes</option>
        </Select>
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? (
        <TableSkeleton />
      ) : !data?.items.length ? (
        <EmptyState icon={ScrollText} title="No matching activity" />
      ) : (
        <Table
          head={
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>What</Th>
              <Th>On</Th>
            </tr>
          }
        >
          {data.items.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-slate-500">{fmtDate(e.occurred_at)}</Td>
              <Td>{e.actor_label ?? (e.actor_type === "system" ? "System" : e.actor_type)}</Td>
              <Td>{ACTION_LABEL[e.action] ?? e.action}</Td>
              <Td className="font-mono text-xs text-slate-500">{e.target_id ?? ""}</Td>
            </tr>
          ))}
        </Table>
      )}
      {data && (
        <Pagination
          page={page}
          pageSize={data.pageSize}
          total={data.total}
          onPage={(p) => set("page", String(p))}
        />
      )}
    </Card>
  );
}

export default function AuditPage() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
