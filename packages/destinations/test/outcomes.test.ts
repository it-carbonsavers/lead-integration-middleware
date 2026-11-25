import { describe, expect, it } from "vitest";
import {
  HubSpotOutcomeReader,
  pickCreditedDeal,
  saleValue,
  type DealOutcome,
} from "../src/index.js";
import { FakeHubSpotCrm } from "../../../test/fake-hubspot-crm.js";

const received = new Date("2026-11-01T00:00:00Z");

function reader(fake: FakeHubSpotCrm, enabled = true) {
  return new HubSpotOutcomeReader({
    enabled,
    baseUrl: "https://hubspot.fake",
    token: "test-token",
    soldPipelinePattern: /assessment|installation/i,
    fetch: fake.fetch,
    sleep: async () => {},
  });
}

function setup() {
  const fake = new FakeHubSpotCrm();
  fake.leads.set("10", {
    hs_pipeline_stage: "qualified-stage-id",
    hs_calls_attempted_count: "3",
    hs_calls_connected_count: "1",
  });
  fake.leads.set("11", {
    hs_pipeline_stage: "unqualified-stage-id",
    hs_lead_disqualification_reason: "Not interested",
    hs_calls_attempted_count: "2",
  });
  return fake;
}

describe("HubSpot outcome reader", () => {
  it("reads stage, calls and the deal linked to the lead, and only reads", async () => {
    const fake = setup();
    fake.deals.set("500", {
      pipeline: "p-assess",
      dealstage: "a-2",
      createdate: "2026-11-02T00:00:00Z",
      proposal_sent_date: "2026-11-05",
      "hs_v2_date_entered_a-1": "2026-11-10T00:00:00Z",
      "hs_v2_date_entered_a-2": "2026-11-12T00:00:00Z",
      total_amount: "",
      amount: "4500",
    });
    fake.leadDeals.set("10", ["500"]);

    const { outcomes, dealsUnreadable } = await reader(fake).read([
      { hubspotLeadId: "10", contactId: "c1", receivedAt: received },
      { hubspotLeadId: "11", contactId: "c2", receivedAt: received },
    ]);

    expect(dealsUnreadable).toBeNull();
    const [a, b] = outcomes;
    expect(a).toMatchObject({
      missing: false,
      leadStage: "Qualified [Create Deal]",
      callsAttempted: 3,
      callsConnected: 1,
      dealCount: 1,
    });
    expect(a!.deal).toMatchObject({
      dealId: "500",
      pipeline: "VIC Heat Pump - Assessments",
      stage: "Awaiting Photos",
      sold: true,
      lost: false,
      saleValue: 4500,
      saleValueField: "amount",
    });
    expect(a!.deal!.soldAt?.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(a!.deal!.proposalSentAt?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(b).toMatchObject({
      leadStage: "Disqualified",
      disqualificationReason: "Not interested",
      deal: null,
      dealCount: 0,
    });

    // Read-only: GETs and batch/read POSTs only.
    for (const c of fake.calls) {
      expect(c.method === "GET" || c.path.endsWith("/batch/read")).toBe(true);
    }
  });

  it("credits a contact's deal only when it was created after the lead arrived", async () => {
    const fake = setup();
    fake.deals.set("600", {
      pipeline: "p-assess",
      dealstage: "a-1",
      createdate: "2025-03-01T00:00:00Z",
      total_amount: "9000",
    });
    fake.deals.set("601", {
      pipeline: "p-sales",
      dealstage: "s-proposal",
      createdate: "2026-11-03T00:00:00Z",
    });
    fake.contactDeals.set("c1", ["600", "601"]);

    const { outcomes } = await reader(fake).read([
      { hubspotLeadId: "10", contactId: "c1", receivedAt: received },
    ]);
    expect(outcomes[0]!.dealCount).toBe(1);
    expect(outcomes[0]!.deal).toMatchObject({ dealId: "601", sold: false, saleValue: null });
  });

  it("marks lost deals with their reason, and leads deleted in HubSpot as missing", async () => {
    const fake = setup();
    fake.deals.set("700", {
      pipeline: "p-sales",
      dealstage: "s-lost",
      createdate: "2026-11-02T00:00:00Z",
      closed_lost_reason: "Price",
    });
    fake.leadDeals.set("10", ["700"]);
    const { outcomes } = await reader(fake).read([
      { hubspotLeadId: "10", contactId: null, receivedAt: received },
      { hubspotLeadId: "99", contactId: null, receivedAt: received },
    ]);
    expect(outcomes[0]!.deal).toMatchObject({ lost: true, lostReason: "Price", sold: false });
    expect(outcomes[1]).toMatchObject({ missing: true, deal: null });
  });

  it("keeps lead outcomes when deals cannot be read (missing scope)", async () => {
    const fake = setup();
    fake.dealsStatus = 403;
    const { outcomes, dealsUnreadable } = await reader(fake).read([
      { hubspotLeadId: "10", contactId: "c1", receivedAt: received },
    ]);
    expect(dealsUnreadable).toMatch(/^hubspot_403/);
    expect(outcomes[0]).toMatchObject({ leadStage: "Qualified [Create Deal]", deal: null });
  });

  it("makes no request when HubSpot is disabled", async () => {
    const fake = setup();
    await expect(
      reader(fake, false).read([{ hubspotLeadId: "10", contactId: null, receivedAt: received }]),
    ).rejects.toMatchObject({ code: "hubspot_disabled" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("sale value and deal choice", () => {
  it("uses total_amount, falling back to amount; zero or empty counts as no value", () => {
    expect(saleValue({ total_amount: "12000", amount: "500" })).toEqual({
      value: 12000,
      field: "total_amount",
    });
    expect(saleValue({ total_amount: "0", amount: "500" })).toEqual({
      value: 500,
      field: "amount",
    });
    expect(saleValue({ total_amount: "", amount: "" })).toEqual({ value: null, field: null });
  });

  it("prefers a sale, then a proposal, then an open deal, then a lost one", () => {
    const base: DealOutcome = {
      dealId: "x",
      pipeline: "",
      stage: "",
      createdAt: new Date("2026-11-02"),
      proposalSentAt: null,
      proposalStatus: null,
      lost: false,
      lostReason: null,
      sold: false,
      soldAt: null,
      saleValue: null,
      saleValueField: null,
    };
    const lost = { ...base, dealId: "lost", lost: true };
    const open = { ...base, dealId: "open" };
    const proposal = { ...base, dealId: "proposal", proposalSentAt: new Date("2026-11-04") };
    const sold = { ...base, dealId: "sold", sold: true };
    expect(pickCreditedDeal([lost, open, proposal, sold])!.dealId).toBe("sold");
    expect(pickCreditedDeal([lost, open, proposal])!.dealId).toBe("proposal");
    expect(pickCreditedDeal([lost, open])!.dealId).toBe("open");
    expect(pickCreditedDeal([lost])!.dealId).toBe("lost");
    expect(pickCreditedDeal([])).toBeNull();
  });
});
