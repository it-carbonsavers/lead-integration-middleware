import { describe, expect, it } from "vitest";
import { normaliseLeadSubmission } from "../src/index.js";

export const validLead = (over: Record<string, unknown> = {}) => ({
  schema_version: "1",
  external_lead_id: "TRX-2026-000123",
  transferred_at: "2026-11-17T09:41:12+11:00",
  customer: {
    first_name: " Alex ",
    last_name: "Example",
    phone: "0491 570 006",
    email: "Alex.Example@Example.com",
    address: {
      line1: "1 Example St",
      city: "Sampletown",
      state: "NSW",
      postcode: "2000",
      country: "au",
    },
  },
  agent: { external_id: "AG-17", name: "Sam Agent" },
  campaign: "Winter energy plans",
  consent: {
    verbal_consent: true,
    captured_at: "2026-11-17T09:40:02+11:00",
    recording_ref: "TRX-2026-000123",
  },
  ...over,
});

const opts = { defaultPhoneRegion: "AU", now: new Date("2026-11-18T00:00:00Z") };

describe("normaliseLeadSubmission", () => {
  it("accepts a valid lead and normalises phone, email, names and country", () => {
    const r = normaliseLeadSubmission(validLead(), opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.customer.phone).toBe("+61491570006");
    expect(r.lead.customer.email).toBe("alex.example@example.com");
    expect(r.lead.customer.first_name).toBe("Alex");
    expect(r.lead.customer.address?.country).toBe("AU");
    expect(r.lead.transferredAt.toISOString()).toBe("2026-11-16T22:41:12.000Z");
  });

  it("accepts international numbers already in +E.164", () => {
    const r = normaliseLeadSubmission(
      validLead({ customer: { first_name: "A", last_name: "B", phone: "+44 20 7946 0958" } }),
      opts,
    );
    expect(r.ok && r.lead.customer.phone).toBe("+442079460958");
  });

  it("strips control characters", () => {
    const r = normaliseLeadSubmission(
      validLead({
        customer: { first_name: "Al\u0000ex\u0007", last_name: "B", phone: "0491570006" },
      }),
      opts,
    );
    expect(r.ok && r.lead.customer.first_name).toBe("Alex");
  });

  it("reports field paths and codes, never values", () => {
    const r = normaliseLeadSubmission(
      validLead({
        external_lead_id: "has spaces!",
        customer: { first_name: "", last_name: "B", phone: "0491570006", email: "nope" },
        unknown_thing: 1,
      }),
      opts,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.errors.map((e) => `${e.path}:${e.code}`);
    expect(paths).toContain("(body):unknown_field");
    expect(paths.some((p) => p.startsWith("external_lead_id:"))).toBe(true);
    expect(paths.some((p) => p.startsWith("customer.first_name:"))).toBe(true);
    expect(paths.some((p) => p.startsWith("customer.email:"))).toBe(true);
    expect(JSON.stringify(r.errors)).not.toContain("nope");
  });

  it("rejects invalid phone numbers, future dates and recordings without consent", () => {
    const r = normaliseLeadSubmission(
      validLead({
        transferred_at: "2026-11-19T00:00:00Z",
        customer: { first_name: "A", last_name: "B", phone: "12345678" },
        consent: { verbal_consent: false, recording_ref: "X1" },
      }),
      opts,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(
      expect.arrayContaining([
        { path: "customer.phone", code: "invalid_phone" },
        { path: "transferred_at", code: "in_future" },
        { path: "consent.recording_ref", code: "recording_without_consent" },
      ]),
    );
  });

  it("requires the schema version", () => {
    const r = normaliseLeadSubmission(validLead({ schema_version: "2" }), opts);
    expect(r.ok).toBe(false);
  });

  it("limits extra fields", () => {
    const extra = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, i]));
    expect(normaliseLeadSubmission(validLead({ extra }), opts).ok).toBe(false);
    expect(normaliseLeadSubmission(validLead({ extra: { simulate: "fail_once" } }), opts).ok).toBe(
      true,
    );
  });
});
