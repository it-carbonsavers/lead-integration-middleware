/**
 * Prints the HubSpot setup the HubSpot destination needs (DRY RUN ONLY, no network calls):
 * the custom Lead property group and properties, and the private-app scopes to request.
 *
 * Applying it to a portal is deliberately not implemented while development is local-only;
 * it will be added (against a HubSpot test portal first) once external connections are approved.
 *
 *   npm run hubspot:plan
 */
import { LEAD_CUSTOM_PROPERTIES } from "@lim/destinations";

const plan = {
  note: "Dry run. Nothing was sent to HubSpot.",
  requiredScopes: [
    "crm.objects.contacts.read",
    "crm.objects.contacts.write",
    "crm.objects.leads.read",
    "crm.objects.leads.write",
    "crm.schemas.leads.write (setup only)",
    "crm.objects.owners.read (only if setOwnerFromAgent=true)",
  ],
  propertyGroup: { objectType: "leads", name: "lead_integration", label: "Lead Integration" },
  properties: LEAD_CUSTOM_PROPERTIES.map((p) => ({
    objectType: "leads",
    groupName: "lead_integration",
    ...p,
  })),
  toConfirm: [
    "Leads object available on the portal's subscription (Q1)",
    "Lead pipeline id and initial stage id (destination config leadPipelineId / leadStageId)",
    "Lead-to-contact association type id (default 578)",
  ],
};
console.log(JSON.stringify(plan, null, 2));
