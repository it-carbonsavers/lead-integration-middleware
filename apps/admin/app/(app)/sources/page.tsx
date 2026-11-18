"use client";

import Link from "next/link";
import { useState } from "react";
import { Plug, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { RecordingHealth, type Source } from "@/components/sources";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  PageHeader,
  pct,
  StatusPill,
  Table,
  TableSkeleton,
  Td,
  Th,
  timeAgo,
  useLoad,
} from "@/components/ui";

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,15}$/;

function AddSource({ onClose, onDone }: { onClose: () => void; onDone: (code: string) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  return (
    <Modal
      title="Add a lead source"
      description="A provider that will send leads through the API."
      onClose={onClose}
    >
      <ErrorBanner error={error} />
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (!CODE_PATTERN.test(code)) {
            setCodeError(
              "Use 3–16 capital letters, digits or _ and start with a letter, e.g. PRV05.",
            );
            return;
          }
          setBusy(true);
          try {
            await api.post("/platforms", { code, display_name: name.trim() });
            onDone(code.toUpperCase());
          } catch (err) {
            setError(err);
            setBusy(false);
          }
        }}
      >
        <Field label="Name" hint="Shown in the dashboard and reports.">
          <Input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lead Provider E"
          />
        </Field>
        <Field
          label="Short code"
          hint={
            codeError ? (
              <span className="text-red-600">{codeError}</span>
            ) : (
              "3–16 capital letters, digits or _, starting with a letter, e.g. PRV05. Used in file names and reports. Cannot be changed later."
            )
          }
        >
          <Input
            required
            value={code}
            aria-invalid={codeError ? true : undefined}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase().trim());
              setCodeError(null);
            }}
            placeholder="PRV05"
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Add source
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function SourcesPage() {
  const { data, error, loading, reload } = useLoad(
    () => api.get<{ items: Source[] }>("/platforms"),
    [],
  );
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader
        title="Lead Sources"
        description="External lead providers that send us leads and consent recordings."
        actions={
          <Button icon={Plus} onClick={() => setAdding(true)}>
            Add source
          </Button>
        }
      />
      <ErrorBanner error={error} onRetry={reload} />
      <Card padded={false}>
        {loading && !data ? (
          <TableSkeleton rows={4} />
        ) : !data?.items.length ? (
          <EmptyState
            icon={Plug}
            title="No lead sources yet"
            text="Add the first provider to give them API access."
          />
        ) : (
          <Table
            head={
              <tr>
                <Th>Source</Th>
                <Th className="text-right">Leads (30 days)</Th>
                <Th className="text-right">Delivered</Th>
                <Th>API</Th>
                <Th>Consent recordings</Th>
                <Th className="text-right">Last lead</Th>
              </tr>
            }
          >
            {data.items.map((s) => (
              <tr
                key={s.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => (window.location.href = `/sources/${s.code}`)}
              >
                <Td>
                  <div className="flex items-center gap-3">
                    <div>
                      <Link
                        href={`/sources/${s.code}`}
                        className="font-medium text-slate-900 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {s.display_name}
                      </Link>
                      <div className="text-xs text-slate-500">{s.code}</div>
                    </div>
                    {s.status !== "active" && <StatusPill status={s.status} />}
                  </div>
                </Td>
                <Td className="text-right tabular-nums">{s.leads_30d.toLocaleString()}</Td>
                <Td className="text-right tabular-nums">{pct(s.delivered_30d, s.leads_30d)}</Td>
                <Td>
                  {s.active_keys === 0 ? (
                    <StatusPill label="No active key" tone="gray" />
                  ) : s.last_api_use_at ? (
                    <span className="text-sm text-slate-600">
                      Used {timeAgo(s.last_api_use_at)}
                    </span>
                  ) : (
                    <StatusPill label="Key issued, not used yet" tone="amber" />
                  )}
                </Td>
                <Td>
                  <RecordingHealth s={s} />
                </Td>
                <Td className="whitespace-nowrap text-right text-slate-500">
                  {timeAgo(s.last_lead_at)}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {adding && (
        <AddSource
          onClose={() => setAdding(false)}
          onDone={(code) => (window.location.href = `/sources/${code}?tab=api`)}
        />
      )}
    </>
  );
}
