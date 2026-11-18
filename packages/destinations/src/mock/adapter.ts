/**
 * Local mock destination (the default for local development).
 *
 * Nothing leaves the machine. It builds exactly the Contact and Lead properties the HubSpot
 * adapter would send, stores them (encrypted) in mock_destination_records, and returns
 * mock ids. Contacts are "deduplicated" by email, else phone, like the HubSpot adapter.
 *
 * Failure simulation for testing retries and error handling: a lead submitted with
 * extra.simulate set to one of
 *   "retryable_error"  fails every attempt with a retryable error (ends in dead_letter)
 *   "fail_once"        fails the first attempt, succeeds on retry
 *   "rate_limited"     fails every attempt as rate limited
 *   "permanent_error"  fails once, permanently (status failed, no retries)
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  blindIndex,
  decrypt,
  encrypt,
  DestinationError,
  type CanonicalLead,
  type DeliveryContext,
  type DeliveryResult,
  type DestinationAdapter,
  type HealthResult,
} from "@lim/core";
import type { Database } from "@lim/db";
import { contactProperties, leadProperties, type HubSpotConfig } from "../hubspot/mapping.js";

export interface MockAdapterOptions {
  db: Kysely<Database>;
  destinationId: string;
  config: HubSpotConfig;
  encryptionKey: string;
  blindIndexKey: string;
}

export class MockDestinationAdapter implements DestinationAdapter {
  readonly type = "mock";
  constructor(private readonly opts: MockAdapterOptions) {}

  async healthCheck(): Promise<HealthResult> {
    return { ok: true, detail: "local mock destination (nothing is sent externally)" };
  }

  async updateConsent(leadRef: string, consentStatus: string): Promise<void> {
    const rec = await this.opts.db
      .selectFrom("mock_destination_records")
      .select(["id", "payload_enc"])
      .where("lead_ref", "=", leadRef)
      .executeTakeFirst();
    if (!rec)
      throw new DestinationError(
        "permanent",
        "mock_record_missing",
        "No mock record for this lead",
      );
    const payload = JSON.parse(decrypt(rec.payload_enc, this.opts.encryptionKey)) as {
      lead: { properties: Record<string, string> };
    };
    payload.lead.properties["lim_consent_status"] = consentStatus;
    await this.opts.db
      .updateTable("mock_destination_records")
      .set({
        payload_enc: encrypt(JSON.stringify(payload), this.opts.encryptionKey),
        updated_at: sql`now()`,
      })
      .where("id", "=", rec.id)
      .execute();
  }

  async deliver(lead: CanonicalLead, ctx: DeliveryContext): Promise<DeliveryResult> {
    switch (lead.simulate) {
      case "retryable_error":
        throw new DestinationError(
          "retryable",
          "mock_unavailable",
          "Simulated destination outage",
          503,
        );
      case "rate_limited":
        throw new DestinationError(
          "rate_limited",
          "mock_rate_limited",
          "Simulated rate limit",
          429,
          30,
        );
      case "permanent_error":
        throw new DestinationError(
          "permanent",
          "mock_rejected",
          "Simulated permanent rejection",
          400,
        );
      case "fail_once":
        if (!ctx.existing["simulatedFailure"]) {
          await ctx.saveProgress({ simulatedFailure: "1" });
          throw new DestinationError(
            "retryable",
            "mock_unavailable",
            "Simulated one-off outage",
            503,
          );
        }
    }

    const contactKey = lead.customer.email
      ? `email:${lead.customer.email}`
      : `phone:${lead.customer.phone}`;
    const contactHash = blindIndex(contactKey, this.opts.blindIndexKey)
      .toString("hex")
      .slice(0, 16);
    const contactId = ctx.existing["contactId"] ?? `mock-contact-${contactHash}`;
    if (!ctx.existing["contactId"]) await ctx.saveProgress({ contactId });

    const payload = {
      contact: { id: contactId, properties: contactProperties(lead) },
      lead: {
        properties: leadProperties(lead, this.opts.config),
        associations: [
          { to: contactId, associationTypeId: this.opts.config.leadToContactAssociationTypeId },
        ],
      },
      note: "Local mock: this is what would be sent to HubSpot. Nothing was sent.",
    };

    const existingRecord = await this.opts.db
      .selectFrom("mock_destination_records")
      .select("id")
      .where("lead_ref", "=", lead.leadRef)
      .executeTakeFirst();
    await this.opts.db
      .insertInto("mock_destination_records")
      .values({
        destination_id: this.opts.destinationId,
        lead_ref: lead.leadRef,
        contact_key: contactHash,
        payload_enc: encrypt(JSON.stringify(payload), this.opts.encryptionKey),
      })
      .onConflict((oc) =>
        oc.column("lead_ref").doUpdateSet({
          payload_enc: (eb) => eb.ref("excluded.payload_enc"),
          updated_at: sql`now()`,
        }),
      )
      .execute();

    const leadId = ctx.existing["leadId"] ?? `mock-lead-${lead.leadRef}`;
    if (!ctx.existing["leadId"]) await ctx.saveProgress({ leadId });

    const sameContactEarlier = await this.opts.db
      .selectFrom("mock_destination_records")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("contact_key", "=", contactHash)
      .where("lead_ref", "<>", lead.leadRef)
      .executeTakeFirstOrThrow();

    return {
      externalIds: { contactId, leadId },
      steps: {
        contact: sameContactEarlier.n > 0 ? "found" : "created",
        lead: existingRecord ? "found" : "created",
      },
    };
  }
}
