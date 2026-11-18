/**
 * Converts between normalised submissions, encrypted database rows and the CanonicalLead that
 * destinations receive. All encryption of lead personal data happens here.
 */

import { blindIndex, decrypt, encrypt, type CanonicalLead, type NormalisedLead } from "@lim/core";
import type { Insertable } from "kysely";
import type { Lead, LeadsTable } from "./schema.js";

export interface CryptoKeys {
  encryptionKey: string;
  blindIndexKey: string;
}

export const phoneIndex = (e164: string, k: CryptoKeys) =>
  blindIndex(`phone:${e164}`, k.blindIndexKey);
export const emailIndex = (email: string, k: CryptoKeys) =>
  blindIndex(`email:${email.trim().toLowerCase()}`, k.blindIndexKey);

const enc = (v: string | undefined | null, k: CryptoKeys) =>
  v ? encrypt(v, k.encryptionKey) : null;

export function leadRowFromSubmission(
  lead: NormalisedLead,
  ids: {
    leadRef: string;
    organisationId: string;
    platformId: string;
    agentId: string | null;
    retentionUntil: Date;
    destinationId: string | null;
  },
  keys: CryptoKeys,
): Insertable<LeadsTable> {
  const c = lead.customer;
  return {
    lead_ref: ids.leadRef,
    organisation_id: ids.organisationId,
    platform_id: ids.platformId,
    agent_id: ids.agentId,
    external_lead_id: lead.external_lead_id,
    status: "queued",
    consent_status: lead.consent.verbal_consent ? "awaiting_recording" : "not_captured",
    first_name: c.first_name,
    last_name: c.last_name,
    email_enc: enc(c.email, keys),
    email_bidx: c.email ? emailIndex(c.email, keys) : null,
    phone_enc: encrypt(c.phone, keys.encryptionKey),
    phone_bidx: phoneIndex(c.phone, keys),
    address_enc: c.address ? encrypt(JSON.stringify(c.address), keys.encryptionKey) : null,
    postcode: c.address?.postcode ?? null,
    state: c.address?.state ?? null,
    country: c.address?.country ?? null,
    campaign: lead.campaign ?? null,
    product_interest: lead.product_interest ?? null,
    energy_plan: lead.energy_plan ?? null,
    notes_enc: enc(lead.notes, keys),
    extra_enc: lead.extra ? encrypt(JSON.stringify(lead.extra), keys.encryptionKey) : null,
    verbal_consent: lead.consent.verbal_consent,
    consent_captured_at: lead.consentCapturedAt,
    recording_ref: lead.consent.recording_ref ?? null,
    transferred_at: lead.transferredAt,
    destination_id: ids.destinationId,
    retention_until: ids.retentionUntil,
  };
}

export interface DecryptedPii {
  email: string | null;
  phone: string;
  address: CanonicalLead["customer"]["address"];
  notes: string | null;
  extra: Record<string, unknown> | null;
}

export function decryptLeadPii(row: Lead, keys: CryptoKeys): DecryptedPii {
  const dec = (b: Buffer | null) => (b ? decrypt(b, keys.encryptionKey) : null);
  const address = dec(row.address_enc);
  const extra = dec(row.extra_enc);
  return {
    email: dec(row.email_enc),
    phone: decrypt(row.phone_enc, keys.encryptionKey),
    address: address ? (JSON.parse(address) as CanonicalLead["customer"]["address"]) : null,
    notes: dec(row.notes_enc),
    extra: extra ? (JSON.parse(extra) as Record<string, unknown>) : null,
  };
}

export function toCanonicalLead(
  row: Lead,
  ctx: {
    platformCode: string;
    agent: { externalId: string; name: string | null; ownerId: string | null } | null;
  },
  keys: CryptoKeys,
): CanonicalLead {
  const pii = decryptLeadPii(row, keys);
  const simulate = pii.extra?.["simulate"];
  return {
    leadRef: row.lead_ref,
    platformCode: ctx.platformCode,
    transferredAt: row.transferred_at,
    customer: {
      firstName: row.first_name,
      lastName: row.last_name,
      phone: pii.phone,
      email: pii.email,
      address: pii.address,
    },
    agent: ctx.agent,
    campaign: row.campaign,
    productInterest: row.product_interest,
    energyPlan: row.energy_plan,
    consent: {
      verbal: row.verbal_consent,
      status: row.consent_status,
      recordingRef: row.recording_ref,
    },
    simulate: typeof simulate === "string" ? simulate : null,
  };
}
