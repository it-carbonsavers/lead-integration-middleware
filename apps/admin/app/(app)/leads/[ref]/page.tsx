"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ChevronDown, Eye, FileAudio, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { can, isProvider, useMe } from "@/lib/me";
import {
  Button,
  Card,
  CardSkeleton,
  EmptyState,
  ErrorBanner,
  fmtDate,
  KeyValue,
  KeyValueSkeleton,
  Notice,
  PageHeader,
  Skeleton,
  StatusPill,
  Stepper,
  type WorkflowStep,
  useLoad,
} from "@/components/ui";

interface LeadDetail {
  lead_ref: string;
  external_lead_id: string;
  origin: "api" | "hubspot_import";
  platform: { code: string; name: string };
  agent: { id: string; external_agent_id: string; name: string | null } | null;
  status: string;
  consent: {
    status: string;
    verbal_consent: boolean;
    captured_at: string | null;
    recording_ref: string | null;
  };
  customer: {
    first_name: string;
    last_name: string;
    phone: string;
    email: string | null;
    location: {
      city: string | null;
      state: string | null;
      postcode: string | null;
      country: string | null;
    };
  };
  campaign: string | null;
  product_interest: string | null;
  transferred_at: string;
  received_at: string;
  attempt_count: number;
  destination: { name: string; type: string } | null;
  destination_ids: Record<string, string>;
  possible_duplicate: boolean;
  possible_duplicate_of: string | null;
  events: { id: string; created_at: string; type: string }[];
  attempts: {
    attempt_no: number;
    status: string;
    error_message: string | null;
    started_at: string;
  }[];
  recordings: { id: string; original_filename: string; status: string; created_at: string }[];
  consent_workflow: WorkflowStep[];
}

interface Revealed {
  email: string | null;
  phone: string;
  address: Record<string, string> | null;
  notes: string | null;
}

const EVENT_LABEL: Record<string, string> = {
  received: "Lead received from source",
  possible_duplicate: "Flagged as a possible duplicate",
  delivery_started: "Delivery to CRM started",
  delivered: "Delivered to CRM",
  delivery_retry_scheduled: "Delivery failed, retry scheduled",
  delivery_failed: "Delivery failed",
  retry_requested: "Retry requested by an administrator",
  consent_recording_matched: "Consent recording matched",
  consent_recording_overdue: "Consent recording overdue",
  consent_status_synced: "CRM updated with consent status",
  personal_data_removed: "Personal data removed (retention)",
};

export default function LeadDetailPage() {
  const { ref } = useParams<{ ref: string }>();
  const me = useMe();
  const { data, error, loading, refreshing, reload } = useLoad(
    () => api.get<LeadDetail>(`/leads/${ref}`),
    [ref],
  );
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showTech, setShowTech] = useState(false);

  if (error && !data) return <ErrorBanner error={error} onRetry={reload} />;
  if (loading && !data) {
    // Same shape as the page: header, then the recording/delivery/activity column and the
    // customer/source column.
    return (
      <div role="status" aria-label="Loading">
        <Skeleton className="mb-2 h-4 w-16" />
        <Skeleton className="mb-2 h-8 w-72" />
        <Skeleton className="mb-6 h-4 w-[28rem] max-w-full" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <CardSkeleton>
              <div className="grid gap-6 md:grid-cols-2">
                <KeyValueSkeleton rows={5} />
                <Skeleton className="h-24 rounded-xl" />
              </div>
            </CardSkeleton>
            <CardSkeleton>
              <KeyValueSkeleton rows={2} />
            </CardSkeleton>
            <CardSkeleton />
          </div>
          <div className="space-y-6">
            <CardSkeleton>
              <KeyValueSkeleton rows={4} />
            </CardSkeleton>
            <CardSkeleton>
              <KeyValueSkeleton rows={6} />
            </CardSkeleton>
          </div>
        </div>
      </div>
    );
  }
  if (!data) return null;
  const d = data;
  const imported = d.origin === "hubspot_import";
  const c = d.customer;
  const failed = d.status === "failed" || d.status === "dead_letter";

  async function reveal() {
    setActionError(null);
    try {
      setRevealed(await api.post<Revealed>(`/leads/${ref}/reveal`));
    } catch (e) {
      setActionError(e);
    }
  }
  async function retry() {
    setActionError(null);
    try {
      await api.post(`/leads/${ref}/retry`);
      setMessage("Delivery queued again. This page updates in a few seconds.");
      // keep the button busy until the new attempt shows, so it is not queued twice
      await new Promise((r) => setTimeout(r, 3000));
      await reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <PageHeader
        back={{ href: "/leads", label: "Leads" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {c.first_name} {c.last_name}
            <StatusPill status={d.status} />
          </span>
        }
        description={`Lead ${d.lead_ref} · source reference ${d.external_lead_id} · received ${fmtDate(d.received_at)}`}
        actions={
          can(me, "leads.operate") && failed ? (
            <Button icon={RefreshCw} onClick={retry}>
              Retry delivery
            </Button>
          ) : null
        }
      />
      <ErrorBanner error={actionError ?? error} onRetry={error ? reload : undefined} />
      {message && (
        <Notice tone="success" onClose={() => setMessage(null)}>
          {message}
        </Notice>
      )}
      {d.possible_duplicate && (
        <Notice tone="warning">
          {d.possible_duplicate_of ? (
            <>
              This may be the same customer as{" "}
              <Link className="font-medium underline" href={`/leads/${d.possible_duplicate_of}`}>
                an earlier lead
              </Link>{" "}
              (same phone or email). It was still processed.
            </>
          ) : (
            "This may be a customer received recently (same phone or email). It was still processed."
          )}
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {imported ? (
            <Card title="Imported from HubSpot">
              <p className="text-sm text-slate-600">
                This lead was already in HubSpot before the integration. It was read from HubSpot so
                its calls, deals and sales count in Performance. Its consent recording and delivery
                are not tracked here, and the contact details are kept in step with HubSpot.
              </p>
            </Card>
          ) : (
            <Card
              loading={refreshing}
              title="Consent recording"
              description="From the call to a matched, stored recording"
              actions={<StatusPill status={d.consent.status} />}
            >
              <div className="grid gap-6 md:grid-cols-2">
                <Stepper steps={d.consent_workflow} />
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    Recording files
                  </h3>
                  {d.recordings.length === 0 ? (
                    <EmptyState
                      icon={FileAudio}
                      title={
                        d.consent.verbal_consent
                          ? "No recording received yet"
                          : "No recording needed"
                      }
                      text={
                        d.consent.verbal_consent
                          ? "It appears here automatically once the source delivers it."
                          : "No verbal consent was captured on the call."
                      }
                    />
                  ) : (
                    <ul className="space-y-3">
                      {d.recordings.map((r) => (
                        <li key={r.id} className="rounded-xl border border-slate-200 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-slate-900">
                              {r.original_filename}
                            </span>
                            <StatusPill status={r.status} />
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            Received {fmtDate(r.created_at)}
                          </div>
                          {can(me, "recordings.play") && r.status !== "deleted" && (
                            <audio
                              controls
                              preload="none"
                              className="mt-2 h-9 w-full"
                              src={`/admin-api/recordings/${r.id}/audio`}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Card>
          )}

          {!imported && (
            <Card
              title="Delivery"
              loading={refreshing}
              description={d.destination ? `To ${d.destination.name}` : undefined}
              actions={<StatusPill status={d.status} />}
            >
              {d.attempts.length === 0 ? (
                <p className="text-sm text-slate-500">Waiting to be delivered.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {d.attempts.map((a) => (
                    <li
                      key={a.attempt_no}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                    >
                      <span className="text-slate-700">
                        Attempt {a.attempt_no} · {fmtDate(a.started_at)}
                      </span>
                      {a.status === "success" ? (
                        <StatusPill status="delivered" />
                      ) : (
                        <span className="flex items-center gap-2">
                          {a.error_message && (
                            <span className="text-xs text-slate-500">{a.error_message}</span>
                          )}
                          <StatusPill
                            label={a.status === "in_progress" ? "In progress" : "Failed"}
                            tone={a.status === "in_progress" ? "blue" : "red"}
                          />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <Card title="Activity" loading={refreshing}>
            <ol className="relative space-y-4 border-l border-slate-200 pl-5">
              {d.events.map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-300" />
                  <div className="text-sm text-slate-900">
                    {EVENT_LABEL[e.type] ?? e.type.replace(/_/g, " ")}
                  </div>
                  <div className="text-xs text-slate-500">{fmtDate(e.created_at)}</div>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-6">
          <Card
            title="Customer"
            actions={
              can(me, "leads.pii_reveal") && !revealed ? (
                <Button size="sm" variant="secondary" icon={Eye} onClick={reveal}>
                  Show details
                </Button>
              ) : null
            }
          >
            <KeyValue
              items={[
                { label: "Name", value: `${c.first_name} ${c.last_name}` },
                { label: "Phone", value: revealed ? revealed.phone : c.phone },
                { label: "Email", value: revealed ? revealed.email : c.email },
                {
                  label: "Location",
                  value:
                    [c.location.city, c.location.state, c.location.postcode]
                      .filter(Boolean)
                      .join(", ") || "—",
                },
                ...(revealed?.address
                  ? [
                      {
                        label: "Address",
                        value: Object.values(revealed.address).filter(Boolean).join(", "),
                      },
                    ]
                  : []),
                ...(revealed?.notes ? [{ label: "Notes", value: revealed.notes }] : []),
              ]}
            />
            {!revealed && can(me, "leads.pii_reveal") && (
              <p className="mt-3 text-xs text-slate-500">
                Contact details are partly hidden. Showing them is recorded.
              </p>
            )}
          </Card>

          <Card title="Source">
            <KeyValue
              items={[
                {
                  label: "Lead source",
                  value: isProvider(me) ? (
                    d.platform.name
                  ) : (
                    <Link className="hover:underline" href={`/sources/${d.platform.code}`}>
                      {d.platform.name}
                    </Link>
                  ),
                },
                {
                  label: "Agent",
                  value: d.agent ? (d.agent.name ?? d.agent.external_agent_id) : "—",
                },
                { label: "Campaign", value: d.campaign ?? "—" },
                { label: "Interest", value: d.product_interest?.replace(/_/g, " ") ?? "—" },
                { label: "Transferred", value: fmtDate(d.transferred_at) },
                { label: "Verbal consent", value: d.consent.verbal_consent ? "Yes" : "No" },
              ]}
            />
          </Card>

          {!isProvider(me) && Object.keys(d.destination_ids).length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <button
                onClick={() => setShowTech(!showTech)}
                className="flex w-full items-center justify-between px-5 py-4 text-sm font-semibold text-slate-900"
              >
                Technical details
                <ChevronDown
                  className={`h-4 w-4 text-slate-400 transition ${showTech ? "rotate-180" : ""}`}
                />
              </button>
              {showTech && (
                <div className="border-t border-slate-100 px-5 pb-4">
                  <KeyValue
                    items={[
                      { label: "Destination", value: d.destination?.name },
                      ...Object.entries(d.destination_ids).map(([k, v]) => ({
                        label: k,
                        value: <code className="text-xs">{v}</code>,
                      })),
                      { label: "Delivery attempts", value: d.attempt_count },
                    ]}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
