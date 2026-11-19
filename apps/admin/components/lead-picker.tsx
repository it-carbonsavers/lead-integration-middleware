"use client";

import { api } from "@/lib/api";
import { Select, Spinner, useLoad } from "@/components/ui";

export interface PickableLead {
  lead_ref: string;
  external_lead_id: string;
  name: string;
  platform: string;
  received_at: string;
  consent_status: string;
  recording_ref: string | null;
}

/**
 * Lists a source's leads to attach a recording to: the ones still waiting for a recording first.
 * Provider users only ever get their own leads (the API scopes the list).
 */
export function useSourceLeads(platform: string | null) {
  return useLoad(
    () =>
      api
        .get<{ items: PickableLead[] }>(
          `/consent?view=all&pageSize=100${platform ? `&platform=${platform}` : ""}`,
        )
        .then((d) =>
          [...d.items].sort((a, b) => {
            const wa = a.consent_status === "matched" ? 1 : 0;
            const wb = b.consent_status === "matched" ? 1 : 0;
            return wa - wb || b.received_at.localeCompare(a.received_at);
          }),
        ),
    [platform],
  );
}

export function leadLabel(l: PickableLead) {
  const waiting = l.consent_status === "matched" ? "has a recording" : "waiting for recording";
  return `${l.name} · ${l.external_lead_id}${l.recording_ref ? ` · expects ${l.recording_ref}` : ""} (${waiting})`;
}

export function LeadPicker({
  leads,
  value,
  onChange,
  emptyLabel,
  disabled,
  failed,
  onRetry,
}: {
  leads: PickableLead[] | null;
  value: string;
  onChange: (leadRef: string) => void;
  emptyLabel: string;
  disabled?: boolean;
  /** The list could not be loaded (shown instead of a picker that never finishes loading). */
  failed?: boolean;
  onRetry?: () => void;
}) {
  if (failed && !leads)
    return (
      <div className="flex items-center gap-2 text-xs text-red-600">
        Couldn&apos;t load the leads.
        {onRetry && (
          <button
            type="button"
            className="font-medium text-emerald-700 hover:underline"
            onClick={onRetry}
          >
            Retry
          </button>
        )}
      </div>
    );
  return (
    <div className="relative">
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || !leads}
        className="text-xs"
        aria-busy={!leads || undefined}
      >
        <option value="">{leads ? emptyLabel : "Loading leads…"}</option>
        {leads?.map((l) => (
          <option key={l.lead_ref} value={l.lead_ref}>
            {leadLabel(l)}
          </option>
        ))}
      </Select>
      {!leads && <Spinner className="absolute right-8 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />}
    </div>
  );
}
