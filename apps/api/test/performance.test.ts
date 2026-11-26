import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDestination,
  createOrganisation,
  createPlatform,
  issueApiCredential,
  type Actor,
} from "@lim/db";
import type { PgBoss } from "@lim/jobs";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/admin/auth.js";
import { createTestDatabase, startTestBoss, type TestDatabase } from "../../../test/helpers.js";

const actor: Actor = { type: "system", label: "test" };
const PW = "correct horse battery staple";
let t: TestDatabase;
let app: FastifyInstance;
let boss: PgBoss;
const keys: Record<string, string> = {};
let seq = 0;

const cookieOf = (res: LightMyRequestResponse) => {
  const c = res.cookies.find((x) => x.name === "lim_admin_session");
  return c ? `lim_admin_session=${c.value}` : "";
};
async function login(email: string, password = PW) {
  const res = await app.inject({
    method: "POST",
    url: "/admin/v1/auth/login",
    headers: { "x-lim-admin": "1" },
    payload: { email, password },
  });
  return cookieOf(res);
}
const get = (cookie: string, url: string) =>
  app.inject({ method: "GET", url: `/admin/v1${url}`, headers: { cookie } });

/** Submits a lead, marks it delivered, and stores its outcome (null = no outcome yet). */
async function lead(
  platform: string,
  outcome: Record<string, unknown> | null,
  campaign = "Spring",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/leads",
    headers: { authorization: `Bearer ${keys[platform]}` },
    payload: {
      schema_version: "1",
      external_lead_id: `PERF-${++seq}`,
      transferred_at: new Date(Date.now() - 3_600_000).toISOString(),
      campaign,
      customer: { first_name: "Test", last_name: "Lead", phone: "0491 570 006" },
      agent: { external_id: "AG-1" },
      consent: { verbal_consent: false },
    },
  });
  expect(res.statusCode).toBe(202);
  const ref = res.json().lead_ref as string;
  const row = await t.db
    .updateTable("leads")
    .set({ status: "delivered", delivered_at: new Date() })
    .where("lead_ref", "=", ref)
    .returning("id")
    .executeTakeFirstOrThrow();
  if (outcome) {
    await t.db
      .insertInto("lead_outcomes")
      .values({ lead_id: row.id, hubspot_lead_id: `HS${seq}`, ...outcome })
      .execute();
  }
  return ref;
}

let staff: string;

beforeAll(async () => {
  t = await createTestDatabase({ config: { RATE_LIMIT_IP_PER_MIN: "5000" } });
  boss = await startTestBoss(t);
  app = await buildApp({ config: t.config, db: t.db, boss, logger: false });
  await app.ready();
  const org = await createOrganisation(t.db, { name: "Org", slug: "org" }, actor);
  await createDestination(
    t.db,
    { type: "mock", name: "Mock", isDefault: true, config: {}, credentialRef: "NONE_REQUIRED" },
    actor,
  );
  for (const code of ["PRVA", "PRVB"]) {
    const p = await createPlatform(
      t.db,
      { organisationId: org.id, code, displayName: `Provider ${code}`, rateLimitPerMin: 5000 },
      actor,
    );
    keys[code] = (
      await issueApiCredential(t.db, { platformId: p.id, envTag: "test" }, actor)
    ).token;
  }
  const u = await t.db
    .insertInto("admin_users")
    .values({
      email: "super@test.local",
      name: "Super",
      auth_provider: "local",
      password_hash: await hashPassword(PW),
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await t.db
    .insertInto("admin_user_roles")
    .values({ user_id: u.id, role_code: "super_admin" })
    .execute();
  staff = await login("super@test.local");

  // PRVA: one sale with a value, one sale without, one lost, one still new, one without outcome.
  await lead("PRVA", {
    lead_stage: "Qualified [Create Deal]",
    calls_attempted: 2,
    calls_connected: 1,
    deal_count: 1,
    proposal_sent_at: new Date(),
    sold: true,
    sold_at: new Date(),
    sale_value: 9000,
    sale_value_field: "total_amount",
    quote_value: 9000,
  });
  await lead("PRVA", { lead_stage: "Qualified [Create Deal]", deal_count: 1, sold: true });
  await lead("PRVA", {
    lead_stage: "Qualified [Create Deal]",
    calls_connected: 1,
    deal_count: 1,
    proposal_sent_at: new Date(),
    lost: true,
    lost_reason: "Price",
    quote_value: 5000,
  });
  await lead("PRVA", { lead_stage: "New" }, "Winter");
  await lead("PRVA", null);
  // PRVB: one disqualified after a call, one still being called.
  await lead("PRVB", {
    lead_stage: "Disqualified",
    lead_stage_id: "unqualified-stage-id",
    calls_attempted: 1,
    calls_connected: 1,
    disqualification_reason: "Not interested",
  });
  await lead("PRVB", { lead_stage: "Attempt 2", calls_attempted: 2 });
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false, close: true });
  await t?.destroy();
});

describe("performance reports", () => {
  it("builds a cumulative funnel with sale value and coverage", async () => {
    const res = await get(staff, "/performance/summary");
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.totals).toMatchObject({
      received: 7,
      tracked: 6,
      contacted: 4,
      interested: 3,
      proposal_sent: 3,
      sold: 2,
      lost: 1,
      sale_value: 9000,
      sold_with_value: 1,
      value_coverage_pct: 50,
      // Both quoted proposals were decided (one sold, one lost), so nothing is still open.
      quoted_value: 14000,
      open_quote_value: 0,
    });
    expect(s.by_outcome).toMatchObject({
      sold: 2,
      lost: 1,
      disqualified: 1,
      attempting: 1,
      new: 1,
      not_tracked: 1,
    });
    expect(s.lost_reasons).toEqual([{ reason: "Price", n: 1 }]);
    expect(s.disqualification_reasons).toEqual([{ reason: "Not interested", n: 1 }]);
    expect(s.campaigns).toEqual(["Spring", "Winter"]);
    expect(s.sync).toMatchObject({ enabled: false });
  });

  it("compares sources and filters by source, campaign and outcome", async () => {
    const items = (await get(staff, "/performance/providers")).json().items;
    const a = items.find((r: { platform: string }) => r.platform === "PRVA");
    const b = items.find((r: { platform: string }) => r.platform === "PRVB");
    expect(a).toMatchObject({
      received: 5,
      sold: 2,
      conversion_rate_pct: 40,
      value_per_lead: 1800,
    });
    expect(b).toMatchObject({ received: 2, sold: 0, conversion_rate_pct: 0 });

    expect((await get(staff, "/performance/summary?platform=PRVB")).json().totals.received).toBe(2);
    expect((await get(staff, "/performance/summary?campaign=Winter")).json().totals.received).toBe(
      1,
    );
    expect((await get(staff, "/performance/summary?outcome=sold")).json().totals.received).toBe(2);
  });

  it("exports one row per lead without personal data, and audits it", async () => {
    const res = await get(staff, "/performance/export.csv?platform=PRVA");
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split("\r\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("lead_ref,source,campaign");
    expect(res.body).toContain(",sold,");
    expect(res.body).toContain("9000");
    expect(res.body).not.toContain("Test");
    expect(res.body).not.toContain("0491");
    const audit = await t.db
      .selectFrom("audit_log")
      .select("action")
      .where("action", "=", "performance.export")
      .execute();
    expect(audit).toHaveLength(1);
  });

  it("lists the leads behind a number, by step, outcome, reason and source", async () => {
    const list = async (qs: string) => (await get(staff, `/performance/leads?${qs}`)).json();
    const sold = await list("step=sold");
    expect(sold.total).toBe(2);
    expect(sold.items[0]).toMatchObject({ name: "Test Lead", outcome: "sold", platform: "PRVA" });
    expect((await list("step=proposal_sent")).total).toBe(3);
    expect((await list("outcome=disqualified")).total).toBe(1);
    const lost = (await list("lost_reason=Price")).items;
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ quote_value: 5000, sale_value: null });
    expect((await list("dq_reason=Not%20interested")).total).toBe(1);
    expect((await list("dq_reason=No%20reason%20given")).total).toBe(0);
    expect((await list("platform=PRVB&step=contacted")).total).toBe(1);
    const paged = await list("pageSize=2&page=2");
    expect(paged).toMatchObject({ total: 7, page: 2, pageSize: 2 });
    expect(paged.items).toHaveLength(2);
  });

  it("shows lead provider users their own source only, with sale values", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/v1/platforms/PRVA/users",
      headers: { cookie: staff, "x-lim-admin": "1" },
      payload: { email: "portal.a@provider.test", name: "Provider A user" },
    });
    expect(created.statusCode).toBe(201);
    const provider = await login("portal.a@provider.test", created.json().temporary_password);

    const summary = (await get(provider, "/performance/summary")).json();
    expect(summary.totals).toMatchObject({ received: 5, sold: 2, sale_value: 9000 });
    expect(summary.sync.deals_unreadable).toBeNull();
    // Asking for another source changes nothing: the provider's scope always applies.
    expect((await get(provider, "/performance/summary?platform=PRVB")).json().totals.received).toBe(
      0,
    );

    const sold = (await get(provider, "/performance/leads?step=sold")).json();
    expect(sold.total).toBe(2);
    expect(sold.items.map((l: { sale_value: number | null }) => l.sale_value)).toContain(9000);
    const all = (await get(provider, "/performance/leads?pageSize=100")).json();
    expect(all.items.every((l: { platform: string }) => l.platform === "PRVA")).toBe(true);

    const csv = await get(provider, "/performance/export.csv");
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("9000");
    expect(csv.body).not.toContain("PRVB");

    // The comparison across sources stays staff only.
    expect((await get(provider, "/performance/providers")).statusCode).toBe(403);
  });
});

describe("environment notice routing", () => {
  it("reports HubSpot as on when the worker has it on, with the sources routed to it", async () => {
    const me = async () => (await get(staff, "/auth/me")).json();
    expect(await me()).toMatchObject({ hubspot_enabled: false, hubspot_sources: [] });

    await t.db
      .insertInto("service_status")
      .values({ name: "worker", detail: JSON.stringify({ hubspot_enabled: true }) })
      .onConflict((oc) =>
        oc.column("name").doUpdateSet({ detail: JSON.stringify({ hubspot_enabled: true }) }),
      )
      .execute();
    const hs = await createDestination(
      t.db,
      { type: "hubspot", name: "HubSpot", isDefault: false, config: {}, credentialRef: "HS_X" },
      actor,
    );
    await t.db
      .updateTable("platforms")
      .set({ destination_id: hs.id })
      .where("code", "=", "PRVB")
      .execute();
    expect(await me()).toMatchObject({
      hubspot_enabled: true,
      hubspot_sources: ["PRVB"],
      hubspot_all_sources: false,
    });
  });

  it("reports the outcome sync as on when the worker has it on", async () => {
    const sync = async () => (await get(staff, "/performance/summary")).json().sync;
    expect(await sync()).toMatchObject({ enabled: false });
    await t.db
      .updateTable("service_status")
      .set({ detail: JSON.stringify({ outcome_sync_enabled: true }) })
      .where("name", "=", "worker")
      .execute();
    expect(await sync()).toMatchObject({ enabled: true });
  });
});

describe("HubSpot Lead Company setting on a source", () => {
  it("saves, shows and clears the value, and audits the change", async () => {
    const patch = (value: string | null) =>
      app.inject({
        method: "PATCH",
        url: "/admin/v1/platforms/PRVA",
        headers: { cookie: staff, "x-lim-admin": "1" },
        payload: { hubspot_lead_company: value },
      });
    const prva = async () =>
      (await get(staff, "/platforms"))
        .json()
        .items.find((p: { code: string }) => p.code === "PRVA");
    expect((await patch("  Example Co  ")).statusCode).toBe(200);
    expect(await prva()).toMatchObject({ hubspot_lead_company: "Example Co", imported_count: 0 });
    expect((await patch("")).statusCode).toBe(200);
    expect(await prva()).toMatchObject({ hubspot_lead_company: null });
    const audits = await t.db
      .selectFrom("audit_log")
      .select("detail")
      .where("action", "=", "platform.updated")
      .execute();
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });
});
