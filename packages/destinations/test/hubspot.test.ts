import { describe, expect, it } from "vitest";
import { DestinationError, type CanonicalLead, type DeliveryContext } from "@lim/core";
import { HubSpotAdapter, hubSpotConfigSchema } from "../src/index.js";
import { FakeHubSpot } from "../../../test/fake-hubspot.js";

const canonical = (over: Partial<CanonicalLead> = {}): CanonicalLead => ({
  leadRef: "LD-01TEST000000000000000000001",
  platformCode: "PRV01",
  transferredAt: new Date("2026-11-17T00:00:00Z"),
  customer: {
    firstName: "Alex",
    lastName: "Example",
    phone: "+61491570006",
    email: "alex@example.com",
    address: {
      line1: "1 Example St",
      city: "Sampletown",
      state: "NSW",
      postcode: "2000",
      country: "AU",
    },
  },
  agent: { externalId: "AG-1", name: "Agent One", ownerId: "77" },
  campaign: "Winter",
  productInterest: "solar",
  energyPlan: null,
  consent: { verbal: true, status: "awaiting_recording", recordingRef: "X1" },
  ...over,
});

function ctx(
  existing: Record<string, string> = {},
): DeliveryContext & { saved: Record<string, string> } {
  const saved: Record<string, string> = { ...existing };
  return {
    existing,
    saved,
    saveProgress: async (ids) => {
      Object.assign(saved, ids);
    },
  };
}

const adapter = (
  fake: FakeHubSpot,
  over: Partial<ConstructorParameters<typeof HubSpotAdapter>[0]> = {},
) =>
  new HubSpotAdapter({
    enabled: true,
    baseUrl: "https://hubspot.fake",
    token: "test-token",
    config: hubSpotConfigSchema.parse({}),
    fetch: fake.fetch,
    sleep: async () => {},
    ...over,
  });

describe("HubSpot adapter", () => {
  it("is disabled by default: no network call at all", async () => {
    const fake = new FakeHubSpot();
    const a = adapter(fake, { enabled: false });
    await expect(a.deliver(canonical(), ctx())).rejects.toMatchObject({
      code: "hubspot_disabled",
      errorClass: "permanent",
    });
    expect((await a.healthCheck()).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("fails permanently without a token", async () => {
    const fake = new FakeHubSpot();
    await expect(
      adapter(fake, { token: undefined }).deliver(canonical(), ctx()),
    ).rejects.toMatchObject({
      code: "credential_missing",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("creates a contact and a lead associated to it, never a deal", async () => {
    const fake = new FakeHubSpot();
    const c = ctx();
    const r = await adapter(fake).deliver(canonical(), c);
    expect(r.steps).toEqual({ contact: "created", lead: "created" });
    expect(fake.contacts).toHaveLength(1);
    expect(fake.leads).toHaveLength(1);
    const l = fake.leads[0]!;
    expect(l.properties).toMatchObject({
      hs_pipeline: "lead-pipeline-id",
      hs_pipeline_stage: "new-stage-id",
      lim_lead_ref: "LD-01TEST000000000000000000001",
      lim_source_platform: "PRV01",
      lim_consent_status: "awaiting_recording",
    });
    expect(l.properties["hubspot_owner_id"]).toBeUndefined(); // owner mapping off by default
    expect(JSON.stringify(l.associations)).toContain(`"id":"${fake.contacts[0]!.id}"`);
    expect(JSON.stringify(l.associations)).toContain("578");
    expect(c.saved).toEqual({ contactId: fake.contacts[0]!.id, leadId: l.id });
    expect(fake.calls.every((x) => x.auth === "Bearer test-token")).toBe(true);
    expect(fake.calls.some((x) => x.path.includes("deal"))).toBe(false);
  });

  it("reuses an existing contact by email and only fills empty properties", async () => {
    const fake = new FakeHubSpot();
    fake.contacts.push({
      id: "55",
      properties: { email: "alex@example.com", firstname: "Alexandra", phone: "" },
    });
    const r = await adapter(fake).deliver(canonical(), ctx());
    expect(r.steps["contact"]).toBe("found_updated");
    expect(fake.contacts).toHaveLength(1);
    expect(fake.contacts[0]!.properties["firstname"]).toBe("Alexandra"); // not overwritten
    expect(fake.contacts[0]!.properties["phone"]).toBe("+61491570006"); // filled
    expect(r.externalIds["contactId"]).toBe("55");
  });

  it("matches by phone when there is no email, and can be told never to update", async () => {
    const fake = new FakeHubSpot();
    fake.contacts.push({ id: "66", properties: { mobilephone: "+61491570006" } });
    const r = await adapter(fake, {
      config: hubSpotConfigSchema.parse({ updateExistingContacts: "never" }),
    }).deliver(canonical({ customer: { ...canonical().customer, email: null } }), ctx());
    expect(r.steps["contact"]).toBe("found");
    expect(fake.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("uses the existing id HubSpot reports on a 409 (search index lag)", async () => {
    const fake = new FakeHubSpot();
    fake.searchLag = true;
    await adapter(fake).deliver(canonical(), ctx());
    const r = await adapter(fake).deliver(
      canonical({ leadRef: "LD-01TEST000000000000000000002" }),
      ctx(),
    );
    expect(r.steps["contact"]).toBe("found");
    expect(fake.contacts).toHaveLength(1);
  });

  it("resumes after a failure between steps without duplicating the contact", async () => {
    const fake = new FakeHubSpot();
    fake.failNext("POST", "/crm/v3/objects/leads", 503, 3);
    const first = ctx();
    const err = await adapter(fake)
      .deliver(canonical(), first)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DestinationError);
    expect((err as DestinationError).errorClass).toBe("retryable");
    expect(first.saved["contactId"]).toBeDefined();

    const second = ctx(first.saved);
    const r = await adapter(fake).deliver(canonical(), second);
    expect(r.steps).toEqual({ contact: "reused", lead: "created" });
    expect(fake.contacts).toHaveLength(1);
    expect(fake.leads).toHaveLength(1);
  });

  it("finds an already-created lead by lim_lead_ref instead of creating a second one", async () => {
    const fake = new FakeHubSpot();
    await adapter(fake).deliver(canonical(), ctx());
    const r = await adapter(fake).deliver(canonical(), ctx({ contactId: fake.contacts[0]!.id }));
    expect(r.steps["lead"]).toBe("found");
    expect(fake.leads).toHaveLength(1);
  });

  it("retries transient errors in-call, then classifies", async () => {
    const fake = new FakeHubSpot();
    fake.failNext("POST", "/crm/v3/objects/contacts/search", 429, 1, undefined, {
      "retry-after": "1",
    });
    await expect(adapter(fake).deliver(canonical(), ctx())).resolves.toBeTruthy();

    const fake2 = new FakeHubSpot();
    fake2.failNext(
      "POST",
      "/crm/v3/objects/contacts/search",
      429,
      5,
      { category: "RATE_LIMITS" },
      { "retry-after": "7" },
    );
    await expect(adapter(fake2).deliver(canonical(), ctx())).rejects.toMatchObject({
      errorClass: "rate_limited",
      code: "hubspot_429_rate_limits",
      retryAfterSeconds: 7,
    });

    const fake3 = new FakeHubSpot();
    fake3.failNext("POST", "/crm/v3/objects/contacts/search", 401, 1);
    await expect(adapter(fake3).deliver(canonical(), ctx())).rejects.toMatchObject({
      errorClass: "permanent",
      httpStatus: 401,
    });
  });

  it("never carries HubSpot response bodies (which may echo personal data) into errors", async () => {
    const fake = new FakeHubSpot();
    fake.failNext("POST", "/crm/v3/objects/contacts/search", 400, 1, {
      category: "VALIDATION_ERROR",
      message: "Property value alex@example.com is invalid",
    });
    const err = (await adapter(fake)
      .deliver(canonical(), ctx())
      .catch((e: unknown) => e)) as DestinationError;
    expect(err.code).toBe("hubspot_400_validation_error");
    expect(JSON.stringify({ m: err.message, c: err.code })).not.toContain("alex@example.com");
  });

  it("sets the owner only when configured and the agent is mapped", async () => {
    const fake = new FakeHubSpot();
    await adapter(fake, { config: hubSpotConfigSchema.parse({ setOwnerFromAgent: true }) }).deliver(
      canonical(),
      ctx(),
    );
    expect(fake.leads[0]!.properties["hubspot_owner_id"]).toBe("77");
  });
});
