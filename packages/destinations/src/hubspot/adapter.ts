/**
 * HubSpot destination adapter: Contact (find or create) + Lead object associated to it. Never a Deal.
 *
 * DISABLED BY DEFAULT. Unless HUBSPOT_ENABLED=true, every call fails immediately with a permanent
 * "hubspot_disabled" error and no network request is made. Local development uses the mock destination.
 *
 * Idempotency: contact and lead ids are saved after each step (ctx.saveProgress), so a retry
 * resumes. If a crash happens between creating the Lead and saving its id, the retry finds it by
 * our lim_lead_ref property before creating another.
 */

import {
  DestinationError,
  type CanonicalLead,
  type DeliveryContext,
  type DeliveryResult,
  type DestinationAdapter,
  type HealthResult,
} from "@lim/core";
import {
  CONTACT_READ_PROPERTIES,
  contactProperties,
  leadProperties,
  type HubSpotConfig,
} from "./mapping.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HubSpotAdapterOptions {
  enabled: boolean;
  baseUrl: string;
  token: string | undefined;
  config: HubSpotConfig;
  fetch?: FetchLike;
  /** In-call retries for 429/502/503/504 before handing back to the job queue. */
  inCallRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface HubSpotObject {
  id: string;
  properties: Record<string, string | null>;
}

const TRANSIENT = new Set([429, 502, 503, 504]);

export class HubSpotAdapter implements DestinationAdapter {
  readonly type = "hubspot";
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HubSpotAdapterOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private guard(): string {
    if (!this.opts.enabled) {
      throw new DestinationError(
        "permanent",
        "hubspot_disabled",
        "HubSpot delivery is disabled (HUBSPOT_ENABLED=false)",
      );
    }
    if (!this.opts.token) {
      throw new DestinationError(
        "permanent",
        "credential_missing",
        "HubSpot token is not configured",
      );
    }
    return this.opts.token;
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      this.guard();
      await this.request("GET", "/crm/v3/objects/contacts?limit=1");
      return { ok: true, detail: "reachable" };
    } catch (err) {
      return { ok: false, detail: err instanceof DestinationError ? err.code : "unreachable" };
    }
  }

  async deliver(lead: CanonicalLead, ctx: DeliveryContext): Promise<DeliveryResult> {
    this.guard();
    const steps: Record<string, string> = {};

    let contactId = ctx.existing["contactId"];
    if (contactId) {
      steps["contact"] = "reused";
    } else {
      const c = await this.findOrCreateContact(lead);
      contactId = c.id;
      steps["contact"] = c.outcome;
      await ctx.saveProgress({ contactId });
    }

    let leadId = ctx.existing["leadId"];
    if (leadId) {
      steps["lead"] = "reused";
    } else {
      const found = await this.searchOne("leads", [
        [{ propertyName: "lim_lead_ref", operator: "EQ", value: lead.leadRef }],
      ]);
      if (found) {
        leadId = found.id;
        steps["lead"] = "found";
      } else {
        const created = await this.request<HubSpotObject>("POST", "/crm/v3/objects/leads", {
          properties: leadProperties(lead, this.opts.config),
          associations: [
            {
              to: { id: contactId },
              types: [
                {
                  associationCategory: "HUBSPOT_DEFINED",
                  associationTypeId: this.opts.config.leadToContactAssociationTypeId,
                },
              ],
            },
          ],
        });
        leadId = created.id;
        steps["lead"] = "created";
      }
      await ctx.saveProgress({ leadId });
    }

    return { externalIds: { contactId, leadId }, steps };
  }

  async updateConsent(
    leadRef: string,
    consentStatus: string,
    externalIds: Record<string, string>,
  ): Promise<void> {
    this.guard();
    const leadId = externalIds["leadId"];
    if (!leadId)
      throw new DestinationError("permanent", "missing_destination_id", "Lead has no HubSpot id");
    await this.request("PATCH", `/crm/v3/objects/leads/${encodeURIComponent(leadId)}`, {
      properties: { lim_consent_status: consentStatus },
    });
  }

  private async findOrCreateContact(lead: CanonicalLead): Promise<{ id: string; outcome: string }> {
    const filters = lead.customer.email
      ? [[{ propertyName: "email", operator: "EQ", value: lead.customer.email }]]
      : [
          [{ propertyName: "phone", operator: "EQ", value: lead.customer.phone }],
          [{ propertyName: "mobilephone", operator: "EQ", value: lead.customer.phone }],
        ];
    const existing = await this.searchOne("contacts", filters, [...CONTACT_READ_PROPERTIES]);
    const wanted = contactProperties(lead);

    if (existing) {
      if (this.opts.config.updateExistingContacts === "never")
        return { id: existing.id, outcome: "found" };
      const fill = Object.fromEntries(
        Object.entries(wanted).filter(([k]) => !existing.properties[k]),
      );
      if (Object.keys(fill).length === 0) return { id: existing.id, outcome: "found" };
      await this.request("PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(existing.id)}`, {
        properties: fill,
      });
      return { id: existing.id, outcome: "found_updated" };
    }

    try {
      const created = await this.request<HubSpotObject>("POST", "/crm/v3/objects/contacts", {
        properties: wanted,
      });
      return { id: created.id, outcome: "created" };
    } catch (err) {
      // Search index lag: the contact exists but was not searchable yet. HubSpot reports its id.
      if (err instanceof HubSpotHttpError && err.httpStatus === 409 && err.existingId) {
        return { id: err.existingId, outcome: "found" };
      }
      throw err;
    }
  }

  private async searchOne(
    objectType: "contacts" | "leads",
    filterGroups: { propertyName: string; operator: string; value: string }[][],
    properties: string[] = ["lim_lead_ref"],
  ): Promise<HubSpotObject | null> {
    const res = await this.request<{ results: HubSpotObject[] }>(
      "POST",
      `/crm/v3/objects/${objectType}/search`,
      { filterGroups: filterGroups.map((filters) => ({ filters })), properties, limit: 1 },
    );
    return res.results[0] ?? null;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.guard();
    const retries = this.opts.inCallRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.opts.baseUrl + path, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        });
      } catch {
        if (attempt < retries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new DestinationError("retryable", "network_error", "HubSpot could not be reached");
      }

      if (res.ok) return (await res.json()) as T;

      const retryAfter = Number(res.headers.get("retry-after"));
      if (TRANSIENT.has(res.status) && attempt < retries) {
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 10) * 1000
            : 1000 * 2 ** attempt;
        await this.sleep(waitMs);
        continue;
      }
      throw await toDestinationError(
        res,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
  }
}

class HubSpotHttpError extends DestinationError {
  constructor(
    cls: ConstructorParameters<typeof DestinationError>[0],
    code: string,
    message: string,
    status: number,
    retryAfter: number | null,
    public readonly existingId: string | null,
  ) {
    super(cls, code, message, status, retryAfter);
  }
}

/**
 * Builds a safe error: status, HubSpot's error category and a fixed message. HubSpot error bodies
 * can echo submitted values (personal data), so the body itself is never stored or logged.
 */
async function toDestinationError(
  res: Response,
  retryAfter: number | null,
): Promise<DestinationError> {
  let category = "";
  let existingId: string | null = null;
  try {
    const body = (await res.json()) as { category?: unknown; message?: unknown };
    if (typeof body.category === "string" && /^[A-Z_]{1,64}$/.test(body.category))
      category = body.category;
    if (res.status === 409 && typeof body.message === "string") {
      existingId = /Existing ID:\s*(\d+)/.exec(body.message)?.[1] ?? null;
    }
  } catch {
    // non-JSON body: ignore
  }
  const code = `hubspot_${res.status}${category ? `_${category.toLowerCase()}` : ""}`;
  if (res.status === 429) {
    return new HubSpotHttpError(
      "rate_limited",
      code,
      "HubSpot rate limit reached",
      429,
      retryAfter,
      null,
    );
  }
  if (res.status >= 500) {
    return new HubSpotHttpError(
      "retryable",
      code,
      "HubSpot server error",
      res.status,
      retryAfter,
      null,
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new HubSpotHttpError(
      "permanent",
      code,
      "HubSpot rejected the credentials or scopes",
      res.status,
      null,
      null,
    );
  }
  return new HubSpotHttpError(
    "permanent",
    code,
    "HubSpot rejected the request",
    res.status,
    null,
    existingId,
  );
}
