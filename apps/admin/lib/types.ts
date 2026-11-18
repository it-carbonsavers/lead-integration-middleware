export interface LeadRow {
  lead_ref: string;
  external_lead_id: string;
  platform: string;
  agent_external_id: string | null;
  agent_name: string | null;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  status: string;
  consent_status: string;
  possible_duplicate_of: string | null;
  possible_duplicate: boolean;
  transferred_at: string;
  received_at: string;
  delivered_at: string | null;
  attempt_count: number;
  last_error_code: string | null;
}

export interface Options {
  sources: { code: string; name: string; status: string }[];
  agents: { id: string; external_agent_id: string; name: string | null; platform: string }[];
}

export interface Overview {
  days: number;
  totals: {
    received: number;
    delivered: number;
    pending: number;
    failed: number;
    consent_pending: number;
    consent_overdue: number;
  };
  by_source: { code: string; display_name: string; leads: number }[];
  by_agent: {
    id: string;
    external_agent_id: string;
    name: string | null;
    code: string;
    leads: number;
    delivered: number;
  }[];
  recent: {
    lead_ref: string;
    first_name: string;
    last_name: string;
    code: string;
    status: string;
    consent_status: string;
    received_at: string;
  }[];
}

export function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Groups detailed statuses into the three everyday buckets used in filters. */
export const STATUS_GROUPS: Record<string, string> = {
  delivered: "delivered",
  pending: "received,queued,delivering,retry_scheduled,held",
  failed: "failed,dead_letter",
};
