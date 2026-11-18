"use client";

import { StatusPill } from "@/components/ui";

export interface Source {
  id: string;
  code: string;
  display_name: string;
  status: string;
  organisation: string;
  active_keys: number;
  lead_count: number;
  leads_30d: number;
  delivered_30d: number;
  last_lead_at: string | null;
  last_api_use_at: string | null;
  recording_ingest_mode: "none" | "sftp_hosted";
  sftp_last_success_at: string | null;
  sftp_last_error: string | null;
  portal_users: number;
  rate_limit_per_min: number | null;
  allowed_cidrs: string[];
  destination_id: string | null;
  destination_override: string | null;
}

export function RecordingHealth({
  s,
}: {
  s: Pick<Source, "recording_ingest_mode" | "sftp_last_success_at" | "sftp_last_error">;
}) {
  if (s.recording_ingest_mode === "none") return <StatusPill label="Not set up" tone="gray" />;
  const method = "SFTP upload";
  if (s.sftp_last_error) return <StatusPill label={`${method} · problem`} tone="red" />;
  if (s.sftp_last_success_at) return <StatusPill label={`${method} · working`} tone="green" />;
  return <StatusPill label={`${method} · not checked yet`} tone="amber" />;
}
