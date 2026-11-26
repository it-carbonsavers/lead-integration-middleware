import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createDestination,
  createOrganisation,
  createPlatform,
  decryptLeadPii,
  phoneIndex,
  type Actor,
} from "@lim/db";
import { runOutcomeSync } from "../src/handlers/outcomes.js";
import { createTestDatabase, testConfig, type TestDatabase } from "../../../test/helpers.js";
import { FakeHubSpotCrm } from "../../../test/fake-hubspot-crm.js";

const actor: Actor = { type: "system", label: "test" };
const log = { info: () => {}, warn: () => {} };
let t: TestDatabase;
let orgId: string;
let platformId: string;
let hubspotId: string;
let mockId: string;
let seq = 0;

async function insertLead(
  destinationId: string,
  ids: Record<string, string>,
  over: { status?: string; receivedDaysAgo?: number } = {},
): Promise<string> {
  seq++;
  const row = await t.db
    .insertInto("leads")
    .values({
      lead_ref: `LD-TEST${seq}`,
      organisation_id: orgId,
      platform_id: platformId,
      external_lead_id: `E-${seq}`,
      status: (over.status ?? "delivered") as "delivered",
      consent_status: "not_captured",
      first_name: "Test",
      last_name: "Lead",
      phone_enc: randomBytes(8),
      phone_bidx: randomBytes(8),
      verbal_consent: false,
      transferred_at: new Date(),
      received_at: new Date(Date.now() - (over.receivedDaysAgo ?? 1) * 86_400_000),
      retention_until: new Date(Date.now() + 86_400_000),
      destination_id: destinationId,
      destination_ids: JSON.stringify(ids),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const outcome = (leadId: string) =>
  t.db.selectFrom("lead_outcomes").selectAll().where("lead_id", "=", leadId).executeTakeFirst();

function deps(fake: FakeHubSpotCrm, over: Record<string, string> = {}) {
  return {
    db: t.db,
    config: testConfig(t.url, {
      HUBSPOT_ENABLED: "true",
      OUTCOME_SYNC_ENABLED: "true",
      ...over,
    }),
    log,
    adapterDeps: { fetch: fake.fetch, env: { HS_TEST_TOKEN: "test-token" }, sleep: async () => {} },
  };
}

beforeAll(async () => {
  t = await createTestDatabase();
  orgId = (await createOrganisation(t.db, { name: "Org", slug: "org" }, actor)).id;
  platformId = (
    await createPlatform(
      t.db,
      { organisationId: orgId, code: "TST01", displayName: "Test", rateLimitPerMin: 100 },
      actor,
    )
  ).id;
  hubspotId = (
    await createDestination(
      t.db,
      {
        type: "hubspot",
        name: "HubSpot",
        isDefault: false,
        config: {},
        credentialRef: "HS_TEST_TOKEN",
      },
      actor,
    )
  ).id;
  mockId = (
    await createDestination(
      t.db,
      { type: "mock", name: "Mock", isDefault: true, config: {}, credentialRef: "NONE_REQUIRED" },
      actor,
    )
  ).id;
});

afterAll(async () => {
  await t?.destroy();
});

describe("runOutcomeSync", () => {
  it("does nothing while switched off", async () => {
    const fake = new FakeHubSpotCrm();
    const r = await runOutcomeSync(deps(fake, { OUTCOME_SYNC_ENABLED: "false" }));
    expect(r.status).toBe("disabled");
    expect(fake.calls).toHaveLength(0);
  });

  it("stores outcomes only for this database's HubSpot-delivered leads", async () => {
    const fake = new FakeHubSpotCrm();
    fake.leads.set("10", {
      hs_pipeline_stage: "qualified-stage-id",
      hs_calls_attempted_count: "2",
      hs_calls_connected_count: "1",
    });
    fake.deals.set("500", {
      pipeline: "p-assess",
      dealstage: "a-1",
      createdate: new Date().toISOString(),
      total_amount: "8200.50",
      amount: "100",
    });
    fake.leadDeals.set("10", ["500"]);

    const delivered = await insertLead(hubspotId, { contactId: "c1", leadId: "10" });
    const missing = await insertLead(hubspotId, { contactId: "c2", leadId: "77" });
    const viaMock = await insertLead(mockId, { recordId: "m1" });
    const failed = await insertLead(hubspotId, {}, { status: "failed" });
    const tooOld = await insertLead(hubspotId, { leadId: "10" }, { receivedDaysAgo: 400 });

    const r = await runOutcomeSync(deps(fake));
    expect(r).toMatchObject({ status: "done", checked: 2, updated: 2, missing: 1, errors: [] });

    const o = await outcome(delivered);
    expect(o).toMatchObject({
      hubspot_lead_id: "10",
      lead_stage: "Qualified [Create Deal]",
      calls_attempted: 2,
      calls_connected: 1,
      deal_id: "500",
      sold: true,
      sale_value: "8200.50",
      sale_value_field: "total_amount",
    });
    expect(o!.sold_at).not.toBeNull();
    expect(await outcome(missing)).toMatchObject({ missing: true });
    expect(await outcome(viaMock)).toBeUndefined();
    expect(await outcome(failed)).toBeUndefined();
    expect(await outcome(tooOld)).toBeUndefined();

    // A later run keeps the first sale date and refreshes the rest.
    const firstSold = o!.sold_at;
    fake.leads.set("10", {
      hs_pipeline_stage: "qualified-stage-id",
      hs_calls_attempted_count: "4",
    });
    await runOutcomeSync(deps(fake));
    const again = await outcome(delivered);
    expect(again!.calls_attempted).toBe(4);
    expect(again!.sold_at?.getTime()).toBe(firstSold!.getTime());
  });

  it("records a HubSpot failure without throwing, and keeps deal data when deals are unreadable", async () => {
    const fake = new FakeHubSpotCrm();
    fake.leads.set("10", { hs_pipeline_stage: "connected-stage-id" });
    fake.dealsStatus = 403;
    await sql`UPDATE lead_outcomes SET synced_at = now() - interval '1 day'`.execute(t.db);

    const r = await runOutcomeSync(deps(fake));
    expect(r.dealsUnreadable).toMatch(/^hubspot_403/);
    const rows = await t.db
      .selectFrom("lead_outcomes")
      .selectAll()
      .where("hubspot_lead_id", "=", "10")
      .execute();
    expect(rows[0]).toMatchObject({
      lead_stage: "Connected/Voicemail",
      deal_id: "500",
      sold: true,
    });

    const off = await runOutcomeSync(deps(fake, { HUBSPOT_ENABLED: "false" }));
    expect(off.errors[0]).toMatchObject({ code: "hubspot_disabled" });
  });
});

describe("importing existing HubSpot leads for a source", () => {
  it("adds leads matching the source's Lead Company once, with their contact details, and syncs them", async () => {
    const code = "IMP01";
    const p = await createPlatform(
      t.db,
      { organisationId: orgId, code, displayName: "Importer", rateLimitPerMin: 100 },
      actor,
    );
    await t.db
      .updateTable("platforms")
      .set({ destination_id: hubspotId, hubspot_lead_company: "Example Co" })
      .where("id", "=", p.id)
      .execute();

    const fake = new FakeHubSpotCrm();
    // Two old leads of this company (one 2 years old), one of another company, one we delivered.
    fake.leads.set("901", {
      lead_company: "Example Co",
      hs_createdate: new Date(Date.now() - 730 * 86_400_000).toISOString(),
      hs_pipeline_stage: "qualified-stage-id",
    });
    fake.leads.set("902", {
      lead_company: "Example Co",
      hs_createdate: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      hs_pipeline_stage: "new-stage-id",
    });
    fake.leads.set("903", { lead_company: "Other Co", hs_createdate: new Date().toISOString() });
    fake.leads.set("904", {
      lead_company: "Example Co",
      lim_lead_ref: "LD-ALREADYOURS",
      hs_createdate: new Date().toISOString(),
    });
    fake.leadContacts.set("901", ["9010"]);
    fake.contacts.set("9010", {
      firstname: "Test",
      lastname: "Person",
      mobilephone: "0491 570 006",
      email: "Test.Person@Example.com",
      state: "VIC",
      zip: "3000",
      country: "Australia",
    });
    fake.deals.set("950", {
      pipeline: "p-assess",
      dealstage: "a-1",
      createdate: new Date(Date.now() - 700 * 86_400_000).toISOString(),
      total_amount: "7000",
    });
    fake.contactDeals.set("9010", ["950"]);

    const r = await runOutcomeSync(deps(fake));
    expect(r.imported).toContainEqual({ platform: code, found: 2, added: 2, detailsUpdated: 1 });

    const rows = await t.db
      .selectFrom("leads")
      .leftJoin("lead_outcomes as o", "o.lead_id", "leads.id")
      .select([
        "leads.external_lead_id",
        "leads.first_name",
        "leads.origin",
        "leads.status",
        "leads.destination_ids",
        "o.sold",
        "o.sale_value",
      ])
      .where("leads.platform_id", "=", p.id)
      .orderBy("leads.external_lead_id")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      external_lead_id: "HS-901",
      first_name: "Test",
      origin: "hubspot_import",
      status: "delivered",
      destination_ids: { leadId: "901", contactId: "9010" },
      // Synced even though it is older than the reporting window; the contact's later deal counts.
      sold: true,
      sale_value: "7000.00",
    });
    expect(rows[1]).toMatchObject({ external_lead_id: "HS-902", first_name: "Imported" });

    // Contact details are copied, encrypted, and searchable like API leads.
    const full = await t.db
      .selectFrom("leads")
      .selectAll()
      .where("external_lead_id", "=", "HS-901")
      .executeTakeFirstOrThrow();
    expect(full).toMatchObject({
      first_name: "Test",
      last_name: "Person",
      state: "VIC",
      postcode: "3000",
      country: "AU",
    });
    const pii = decryptLeadPii(full, {
      encryptionKey: t.config.APP_ENCRYPTION_KEY,
      blindIndexKey: t.config.APP_BLIND_INDEX_KEY,
    });
    expect(pii).toMatchObject({ phone: "+61491570006", email: "test.person@example.com" });
    expect(
      full.phone_bidx.equals(
        phoneIndex("+61491570006", {
          encryptionKey: t.config.APP_ENCRYPTION_KEY,
          blindIndexKey: t.config.APP_BLIND_INDEX_KEY,
        }),
      ),
    ).toBe(true);

    // Running again adds nothing.
    const again = await runOutcomeSync(deps(fake));
    expect(again.imported).toContainEqual({
      platform: code,
      found: 2,
      added: 0,
      detailsUpdated: 1,
    });
  });
});
