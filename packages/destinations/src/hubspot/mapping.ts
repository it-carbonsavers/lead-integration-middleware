/**
 * How a CanonicalLead maps onto HubSpot Contact and Lead properties.
 * Shared by the real HubSpot adapter and the local mock destination, so the mock shows exactly
 * what would be sent to HubSpot.
 */

import { z } from "zod";
import type { CanonicalLead } from "@lim/core";

/**
 * destinations.config for type "hubspot" (and "mock", which reuses it).
 * Defaults are HubSpot's standard lead pipeline ids: confirm against the client portal (open question Q1).
 */
export const hubSpotConfigSchema = z.object({
  leadPipelineId: z.string().min(1).default("lead-pipeline-id"),
  leadStageId: z.string().min(1).default("new-stage-id"),
  /** HubSpot-defined association type "lead to primary contact". Verify in the target portal. */
  leadToContactAssociationTypeId: z.number().int().positive().default(578),
  /** fill_empty: only set contact properties that are currently empty. never: do not touch existing contacts. */
  updateExistingContacts: z.enum(["fill_empty", "never"]).default("fill_empty"),
  /** Set the Lead owner from the agent's mapped HubSpot owner id (open question Q3). */
  setOwnerFromAgent: z.boolean().default(false),
});
export type HubSpotConfig = z.infer<typeof hubSpotConfigSchema>;

export const CONTACT_READ_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "mobilephone",
  "address",
  "city",
  "state",
  "zip",
  "country",
] as const;

/** Custom Lead properties created by the setup script (group "lead_integration"). */
export const LEAD_CUSTOM_PROPERTIES: {
  name: string;
  label: string;
  type: "string" | "datetime" | "enumeration";
  fieldType: "text" | "date" | "booleancheckbox";
}[] = [
  { name: "lim_lead_ref", label: "Lead Integration reference", type: "string", fieldType: "text" },
  { name: "lim_source_platform", label: "Source platform", type: "string", fieldType: "text" },
  { name: "lim_agent_external_id", label: "Source agent id", type: "string", fieldType: "text" },
  { name: "lim_agent_name", label: "Source agent name", type: "string", fieldType: "text" },
  { name: "lim_campaign", label: "Campaign", type: "string", fieldType: "text" },
  { name: "lim_product_interest", label: "Product interest", type: "string", fieldType: "text" },
  { name: "lim_energy_plan", label: "Energy plan", type: "string", fieldType: "text" },
  {
    name: "lim_consent_status",
    label: "Consent recording status",
    type: "string",
    fieldType: "text",
  },
  {
    name: "lim_verbal_consent",
    label: "Verbal consent captured",
    type: "string",
    fieldType: "text",
  },
  { name: "lim_transferred_at", label: "Transferred at", type: "datetime", fieldType: "date" },
];

const compact = (o: Record<string, string | undefined | null>) =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as Record<string, string>;

export function contactProperties(lead: CanonicalLead): Record<string, string> {
  const a = lead.customer.address;
  return compact({
    firstname: lead.customer.firstName,
    lastname: lead.customer.lastName,
    email: lead.customer.email,
    phone: lead.customer.phone,
    address: a ? [a.line1, a.line2].filter(Boolean).join(", ") : null,
    city: a?.city,
    state: a?.state,
    zip: a?.postcode,
    country: a?.country,
  });
}

export function leadProperties(lead: CanonicalLead, cfg: HubSpotConfig): Record<string, string> {
  return compact({
    hs_lead_name: `${lead.customer.firstName} ${lead.customer.lastName}`,
    hs_pipeline: cfg.leadPipelineId,
    hs_pipeline_stage: cfg.leadStageId,
    hubspot_owner_id: cfg.setOwnerFromAgent ? lead.agent?.ownerId : null,
    lim_lead_ref: lead.leadRef,
    lim_source_platform: lead.platformCode,
    lim_agent_external_id: lead.agent?.externalId,
    lim_agent_name: lead.agent?.name,
    lim_campaign: lead.campaign,
    lim_product_interest: lead.productInterest,
    lim_energy_plan: lead.energyPlan,
    lim_consent_status: lead.consent.status,
    lim_verbal_consent: String(lead.consent.verbal),
    lim_transferred_at: lead.transferredAt.toISOString(),
  });
}
