import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDestination, createOrganisation, createPlatform, type Actor } from "@lim/db";
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
