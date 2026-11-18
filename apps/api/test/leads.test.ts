import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUES } from "@lim/core";
import { createOrganisation, createPlatform, issueApiCredential, type Actor } from "@lim/db";
import type { PgBoss } from "@lim/jobs";
import { buildApp } from "../src/app.js";
import { createTestDatabase, startTestBoss, type TestDatabase } from "../../../test/helpers.js";

const actor: Actor = { type: "system", label: "test" };
let t: TestDatabase;
let app: FastifyInstance;
let boss: PgBoss;
let keyA: string;
let keyB: string;
let seq = 0;

const lead = (over: Record<string, unknown> = {}) => ({
  schema_version: "1",
  external_lead_id: `EXT-${++seq}`,
  transferred_at: new Date(Date.now() - 60_000).toISOString(),
  customer: {
    first_name: "Alex",
    last_name: "Example",
    phone: "0491 570 006",
    email: `alex${seq}@example.com`,
    address: {
      line1: "1 Example St",
      city: "Sampletown",
      state: "NSW",
      postcode: "2000",
      country: "AU",
    },
  },
  agent: { external_id: "AG-1", name: "Agent One" },
  consent: { verbal_consent: true, recording_ref: `EXT-${seq}` },
  ...over,
});

const submit = (key: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/leads",
    headers: { authorization: `Bearer ${key}`, ...headers },
    payload: body as object,
  });

beforeAll(async () => {
  t = await createTestDatabase({ config: { RATE_LIMIT_IP_PER_MIN: "1000" } });
  boss = await startTestBoss(t);
  app = await buildApp({ config: t.config, db: t.db, boss, logger: false });
  await app.ready();
  const org = await createOrganisation(t.db, { name: "Org", slug: "org" }, actor);
  for (const code of ["PRVA", "PRVB"]) {
    const p = await createPlatform(
      t.db,
      { organisationId: org.id, code, displayName: code, rateLimitPerMin: 1000 },
      actor,
    );
    const k = await issueApiCredential(t.db, { platformId: p.id, envTag: "test" }, actor);
    if (code === "PRVA") keyA = k.token;
    else keyB = k.token;
  }
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false, close: true });
  await t?.destroy();
});

describe("POST /v1/leads", () => {
  it("accepts a lead: 202, stored encrypted, timeline, submission and delivery job created", async () => {
    const body = lead();
    const res = await submit(keyA, body);
    expect(res.statusCode).toBe(202);
    const json = res.json();
    expect(json).toMatchObject({
      external_lead_id: body.external_lead_id,
      status: "queued",
      duplicate: false,
    });
    expect(json.lead_ref).toMatch(/^LD-/);
    expect(res.headers.location).toBe(`/v1/leads/${json.lead_ref}`);

    const row = await t.db
      .selectFrom("leads")
      .selectAll()
      .where("lead_ref", "=", json.lead_ref)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("queued");
    expect(row.consent_status).toBe("awaiting_recording");
    expect(row.first_name).toBe("Alex");
    // Personal data is not stored in clear.
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(body.customer.email);
    expect(raw).not.toContain("491570006");
    expect(raw).not.toContain("Example St");

    const agent = await t.db
      .selectFrom("agents")
      .selectAll()
      .where("id", "=", row.agent_id!)
      .executeTakeFirstOrThrow();
    expect(agent.external_agent_id).toBe("AG-1");

    const events = await t.db
      .selectFrom("lead_events")
      .select("type")
      .where("lead_id", "=", row.id)
      .execute();
    expect(events.map((e) => e.type)).toEqual(["received"]);

    const sub = await t.db
      .selectFrom("submissions")
      .selectAll()
      .where("lead_id", "=", row.id)
      .execute();
    expect(sub).toHaveLength(1);
    expect(sub[0]!.outcome).toBe("accepted");
    expect(JSON.stringify(sub)).not.toContain(body.customer.email);

    const jobs = await boss.findJobs<{ leadId: string }>(QUEUES.deliverLead.name);
    expect(jobs.some((j) => j.data.leadId === row.id)).toBe(true);
  });

  it("replays the same external_lead_id without creating or delivering a second lead", async () => {
    const body = lead();
    const first = await submit(keyA, body);
    const second = await submit(keyA, body);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ lead_ref: first.json().lead_ref, duplicate: true });
    const count = await t.db
      .selectFrom("leads")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("external_lead_id", "=", body.external_lead_id)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
    const subs = await t.db
      .selectFrom("submissions")
      .select("outcome")
      .where("external_lead_id", "=", body.external_lead_id)
      .execute();
    expect(subs.map((s) => s.outcome).sort()).toEqual(["accepted", "duplicate"]);
  });

  it("lets two providers use the same external id independently", async () => {
    const body = lead();
    expect((await submit(keyA, body)).statusCode).toBe(202);
    expect((await submit(keyB, body)).statusCode).toBe(202);
  });

  it("honours Idempotency-Key and refuses its reuse for a different lead", async () => {
    const key = "idem-key-0001";
    const body = lead();
    const a = await submit(keyA, body, { "idempotency-key": key });
    const b = await submit(keyA, body, { "idempotency-key": key });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(200);
    expect(b.json().duplicate).toBe(true);
    const c = await submit(keyA, lead(), { "idempotency-key": key });
    expect(c.statusCode).toBe(409);
    expect((await submit(keyA, lead(), { "idempotency-key": "bad key!" })).statusCode).toBe(400);
  });

  it("handles concurrent identical submissions safely", async () => {
    const body = lead();
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(keyA, body)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 200, 202]);
    expect(new Set(results.map((r) => r.json().lead_ref)).size).toBe(1);
  });

  it("flags the same customer from another provider as a possible duplicate (still accepted)", async () => {
    const phone = "0491 571 266";
    const first = await submit(
      keyA,
      lead({ customer: { first_name: "Jo", last_name: "Dup", phone } }),
    );
    const second = await submit(
      keyB,
      lead({ customer: { first_name: "Jo", last_name: "Dup", phone } }),
    );
    expect(first.json().possible_duplicate).toBe(false);
    expect(second.statusCode).toBe(202);
    expect(second.json().possible_duplicate).toBe(true);
    const row = await t.db
      .selectFrom("leads")
      .select(["id", "possible_duplicate_of"])
      .where("lead_ref", "=", second.json().lead_ref)
      .executeTakeFirstOrThrow();
    const original = await t.db
      .selectFrom("leads")
      .select("id")
      .where("lead_ref", "=", first.json().lead_ref)
      .executeTakeFirstOrThrow();
    expect(row.possible_duplicate_of).toBe(original.id);
    const events = await t.db
      .selectFrom("lead_events")
      .select("type")
      .where("lead_id", "=", row.id)
      .execute();
    expect(events.map((e) => e.type)).toContain("possible_duplicate");
  });

  it("rejects invalid leads with 422, records the rejection, creates no lead", async () => {
    const before = await t.db
      .selectFrom("leads")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    const res = await submit(
      keyA,
      lead({
        external_lead_id: "REJ-1",
        customer: { first_name: "A", last_name: "B", phone: "12345678" },
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toEqual([{ path: "customer.phone", code: "invalid_phone" }]);
    expect(res.body).not.toContain("12345678");
    const after = await t.db
      .selectFrom("leads")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    expect(after.n).toEqual(before.n);
    const sub = await t.db
      .selectFrom("submissions")
      .selectAll()
      .where("external_lead_id", "=", "REJ-1")
      .executeTakeFirstOrThrow();
    expect(sub.outcome).toBe("rejected");
    expect(sub.http_status).toBe(422);
    expect(sub.error_summary).toEqual([{ path: "customer.phone", code: "invalid_phone" }]);
  });

  it("marks leads without verbal consent as not_captured", async () => {
    const res = await submit(keyA, lead({ consent: { verbal_consent: false } }));
    const row = await t.db
      .selectFrom("leads")
      .select("consent_status")
      .where("lead_ref", "=", res.json().lead_ref)
      .executeTakeFirstOrThrow();
    expect(row.consent_status).toBe("not_captured");
  });

  it("requires authentication", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/v1/leads", payload: lead() })).statusCode,
    ).toBe(401);
  });
});

describe("GET /v1/leads", () => {
  it("returns status for the provider's own lead only", async () => {
    const body = lead();
    const ref = (await submit(keyA, body)).json().lead_ref;
    const own = await app.inject({
      url: `/v1/leads/${ref}`,
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      lead_ref: ref,
      status: "queued",
      consent_status: "awaiting_recording",
      delivered_at: null,
    });
    expect(own.body).not.toContain("example.com");

    const other = await app.inject({
      url: `/v1/leads/${ref}`,
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(other.statusCode).toBe(404);

    const byExt = await app.inject({
      url: `/v1/leads?external_lead_id=${encodeURIComponent(body.external_lead_id)}`,
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(byExt.json().items.map((i: { lead_ref: string }) => i.lead_ref)).toEqual([ref]);
    const byExtOther = await app.inject({
      url: `/v1/leads?external_lead_id=${encodeURIComponent(body.external_lead_id)}`,
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(byExtOther.json()).toMatchObject({ items: [], total: 0 });
  });

  it("lists only the provider's own leads, paginated and filterable", async () => {
    const get = (key: string, qs: string) =>
      app.inject({ url: `/v1/leads?${qs}`, headers: { authorization: `Bearer ${key}` } });
    const page1 = (await get(keyA, "page_size=2")).json();
    const page2 = (await get(keyA, "page_size=2&page=2")).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBeGreaterThan(2);
    expect(page2.items[0].lead_ref).not.toBe(page1.items[0].lead_ref);
    const totalA = page1.total;
    const totalB = (await get(keyB, "")).json().total;
    const dbCount = await t.db
      .selectFrom("leads")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    expect(totalA + totalB).toBe(Number(dbCount.n));
    const queued = (
      await app.inject({
        url: "/v1/leads?status=queued&page_size=200",
        headers: { authorization: `Bearer ${keyA}` },
      })
    ).json();
    expect(queued.items.every((i: { status: string }) => i.status === "queued")).toBe(true);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const none = (
      await app.inject({
        url: `/v1/leads?received_from=${encodeURIComponent(future)}`,
        headers: { authorization: `Bearer ${keyA}` },
      })
    ).json();
    expect(none.total).toBe(0);
    expect(
      (await app.inject({ url: "/v1/leads?bogus=1", headers: { authorization: `Bearer ${keyA}` } }))
        .statusCode,
    ).toBe(422);
  });

  it("validates the lead reference format", async () => {
    const res = await app.inject({
      url: "/v1/leads/not-a-ref",
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(res.statusCode).toBe(422);
  });
});
