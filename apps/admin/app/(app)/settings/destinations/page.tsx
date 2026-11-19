"use client";

import { useState } from "react";
import { Wifi } from "lucide-react";
import { api } from "@/lib/api";
import {
  Button,
  Card,
  CardSkeleton,
  ErrorBanner,
  KeyValue,
  Notice,
  StatusPill,
  useLoad,
} from "@/components/ui";

interface Destination {
  id: string;
  name: string;
  type: string;
  is_default: boolean;
  status: string;
  config: Record<string, unknown>;
  credential_present: boolean;
}

export default function DestinationsPage() {
  const { data, error, loading, refreshing, reload } = useLoad(
    () => api.get<{ items: Destination[]; hubspot_enabled: boolean }>("/destinations"),
    [],
  );
  const [result, setResult] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [actionError, setActionError] = useState<unknown>(null);
  if (loading && !data)
    return (
      <div className="space-y-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  return (
    <div className="space-y-6">
      <ErrorBanner error={error ?? actionError} onRetry={reload} />
      {data && !data.hubspot_enabled && (
        <Notice tone="info">
          HubSpot delivery is switched off in this environment. Leads go to the test destination,
          which shows exactly what HubSpot would receive.
        </Notice>
      )}
      {data?.items.map((d) => (
        <Card
          key={d.id}
          loading={refreshing}
          title={
            <span className="flex items-center gap-2">
              {d.name} {d.is_default && <StatusPill label="Standard destination" tone="green" />}
            </span>
          }
          description={
            d.type === "hubspot"
              ? "Creates a Contact and a Lead in HubSpot (never a Deal)."
              : "Local test destination: nothing leaves this computer."
          }
          actions={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon={Wifi}
                onClick={async () => {
                  try {
                    const r = await api.post<{ ok: boolean; detail: string }>(
                      `/destinations/${d.id}/test`,
                    );
                    setResult((prev) => ({ ...prev, [d.id]: r }));
                  } catch (e) {
                    setActionError(e);
                  }
                }}
              >
                Test
              </Button>
              {!d.is_default && d.status === "active" && (
                <Button
                  size="sm"
                  onClick={async () => {
                    if (!confirm(`Make "${d.name}" the standard destination for all sources?`))
                      return;
                    try {
                      await api.post(`/destinations/${d.id}/default`);
                      await reload();
                    } catch (e) {
                      setActionError(e);
                    }
                  }}
                >
                  Make standard
                </Button>
              )}
            </div>
          }
        >
          <KeyValue
            items={[
              { label: "Status", value: <StatusPill status={d.status} /> },
              {
                label: "Credentials",
                value:
                  d.type === "mock"
                    ? "Not needed"
                    : d.credential_present
                      ? "Set (stored as a secret)"
                      : "Not set",
              },
              ...(d.type === "hubspot"
                ? [
                    {
                      label: "Lead pipeline",
                      value: String(d.config["leadPipelineId"] ?? "Standard lead pipeline"),
                    },
                    { label: "Starting stage", value: String(d.config["leadStageId"] ?? "New") },
                  ]
                : []),
            ]}
          />
          {result[d.id] && (
            <p className={`mt-3 text-sm ${result[d.id]!.ok ? "text-emerald-700" : "text-red-600"}`}>
              {result[d.id]!.ok ? "Working" : "Not available"}:{" "}
              {result[d.id]!.detail.replace(/_/g, " ")}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
