/**
 * Destination Integration Layer contract.
 *
 * The core only knows this interface. HubSpot is one implementation; the local "mock" destination
 * is another. Replacing the CRM means adding an adapter and pointing the destination row at it:
 * providers, API, validation, tracking and admin do not change.
 */

/** What a destination receives: only the fields it needs (PII minimisation). */
export interface CanonicalLead {
  leadRef: string;
  platformCode: string;
  transferredAt: Date;
  customer: {
    firstName: string;
    lastName: string;
    /** E.164 */
    phone: string;
    email: string | null;
    address: {
      line1: string;
      line2?: string;
      city?: string;
      state?: string;
      postcode?: string;
      country?: string;
    } | null;
  };
  agent: { externalId: string; name: string | null; ownerId: string | null } | null;
  campaign: string | null;
  productInterest: string | null;
  energyPlan: string | null;
  consent: { verbal: boolean; status: string; recordingRef: string | null };
  /** Test-only hint honoured by the mock destination (from extra.simulate). Ignored by real adapters. */
  simulate?: string | null;
}

export type DeliveryStep = "contact" | "lead";

export interface DeliveryContext {
  /** Ids already created by earlier (partially failed) attempts, so a retry resumes instead of duplicating. */
  existing: Record<string, string>;
  /** Persist an id as soon as a step succeeds. */
  saveProgress: (ids: Record<string, string>) => Promise<void>;
  signal?: AbortSignal;
}

export interface DeliveryResult {
  externalIds: Record<string, string>;
  /** Per-step outcome for the delivery attempt record, e.g. { contact: "found", lead: "created" } */
  steps: Record<string, string>;
}

export type ErrorClass = "retryable" | "rate_limited" | "permanent";

/** Error thrown by adapters. `code` and `message` must be safe to store and show (no PII, no upstream bodies). */
export class DestinationError extends Error {
  constructor(
    public readonly errorClass: ErrorClass,
    public readonly code: string,
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "DestinationError";
  }
}

export interface HealthResult {
  ok: boolean;
  detail: string;
}

export interface DestinationAdapter {
  readonly type: string;
  healthCheck(): Promise<HealthResult>;
  /** Must be idempotent for the same leadRef (see DeliveryContext.existing). */
  deliver(lead: CanonicalLead, ctx: DeliveryContext): Promise<DeliveryResult>;
  /**
   * Optional: update the consent-recording status on an already delivered lead.
   * `externalIds` are the ids returned by deliver().
   */
  updateConsent?(
    leadRef: string,
    consentStatus: string,
    externalIds: Record<string, string>,
  ): Promise<void>;
}
