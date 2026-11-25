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
import { HubSpotClient, HubSpotHttpError, type HubSpotClientOptions } from "./client.js";

export type { FetchLike } from "./client.js";

export interface HubSpotAdapterOptions extends HubSpotClientOptions {
  config: HubSpotConfig;
}

interface HubSpotObject {
  id: string;
  properties: Record<string, string | null>;
}

export class HubSpotAdapter implements DestinationAdapter {
  readonly type = "hubspot";
  private readonly client: HubSpotClient;

  constructor(private readonly opts: HubSpotAdapterOptions) {
    this.client = new HubSpotClient(opts);
  }

  private guard(): string {
    return this.client.guard();
  }

  private request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.client.request<T>(method, path, body);
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
}
