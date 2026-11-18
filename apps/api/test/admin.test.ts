import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";
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
let keyA: string;
let keyOther: string;
const refs: Record<string, string> = {};

async function createUser(email: string, roles: string[], organisationId: string | null = null) {
  const u = await t.db
    .insertInto("admin_users")
    .values({
      email,
      name: email,
      auth_provider: "local",
      password_hash: await hashPassword(PW),
      status: "active",
      organisation_id: organisationId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await t.db
    .insertInto("admin_user_roles")
    .values(roles.map((role_code) => ({ user_id: u.id, role_code })))
    .execute();
  return u.id;
}

const cookieOf = (res: LightMyRequestResponse) => {
  const c = res.cookies.find((x) => x.name === "lim_admin_session");
  return c ? `lim_admin_session=${c.value}` : "";
};

async function loginAs(email: string, password = PW) {
  const res = await app.inject({
    method: "POST",
    url: "/admin/v1/auth/login",
    headers: { "x-lim-admin": "1" },
    payload: { email, password },
  });
  return { res, cookie: cookieOf(res) };
}

function as(cookie: string) {
  return {
    get: (url: string) =>
      app.inject({ method: "GET", url: `/admin/v1${url}`, headers: { cookie } }),
    post: (url: string, payload?: object) =>
      app.inject({
        method: "POST",
        url: `/admin/v1${url}`,
        headers: { cookie, "x-lim-admin": "1" },
        ...(payload ? { payload } : {}),
      }),
    patch: (url: string, payload: object) =>
      app.inject({
        method: "PATCH",
        url: `/admin/v1${url}`,
        headers: { cookie, "x-lim-admin": "1" },
        payload,
      }),
    del: (url: string) =>
      app.inject({
        method: "DELETE",
        url: `/admin/v1${url}`,
        headers: { cookie, "x-lim-admin": "1" },
      }),
  };
}

const submit = async (key: string, over: Record<string, unknown>, name = "submitted") => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/leads",
    headers: { authorization: `Bearer ${key}` },
    payload: {
      schema_version: "1",
      external_lead_id: `ADM-${Object.keys(refs).length}-${Math.random().toString(36).slice(2, 8)}`,
      transferred_at: new Date(Date.now() - 3_600_000).toISOString(),
      customer: {
        first_name: "Alex",
        last_name: "Example",
        phone: "0491 570 006",
        email: "alex@example.com",
      },
      agent: { external_id: "AG-1", name: "Agent One" },
      consent: { verbal_consent: true },
      ...over,
    },
  });
  expect(res.statusCode).toBe(202);
  refs[name] = res.json().lead_ref;
  return res.json().lead_ref as string;
};

let admin: ReturnType<typeof as>;

beforeAll(async () => {
  t = await createTestDatabase({
    config: {
      RATE_LIMIT_IP_PER_MIN: "5000",
      ADMIN_LOCKOUT_THRESHOLD: "3",
      ADMIN_LOGIN_RATE_PER_MIN: "1000",
    },
  });
  boss = await startTestBoss(t);
  app = await buildApp({ config: t.config, db: t.db, boss, logger: false });
  await app.ready();
  const org = await createOrganisation(t.db, { name: "Org", slug: "org" }, actor);
  const other = await createOrganisation(t.db, { name: "Other", slug: "other" }, actor);
  await createDestination(
    t.db,
    { type: "mock", name: "Mock", isDefault: true, config: {}, credentialRef: "NONE_REQUIRED" },
    actor,
  );
  const pA = await createPlatform(
    t.db,
    { organisationId: org.id, code: "PRVA", displayName: "A", rateLimitPerMin: 5000 },
    actor,
  );
  const pO = await createPlatform(
    t.db,
    { organisationId: other.id, code: "PRVO", displayName: "O", rateLimitPerMin: 5000 },
    actor,
  );
  keyA = (await issueApiCredential(t.db, { platformId: pA.id, envTag: "test" }, actor)).token;
  keyOther = (await issueApiCredential(t.db, { platformId: pO.id, envTag: "test" }, actor)).token;

  await submit(
    keyA,
    {
      customer: {
        first_name: "Alex",
        last_name: "Example",
        phone: "0491 570 006",
        email: "alex@example.com",
      },
    },
    "alex",
  );
  await submit(
    keyA,
    {
      customer: {
        first_name: "=SUM(A1)",
        last_name: "Formula",
        phone: "0491 570 156",
        email: "f@example.com",
      },
    },
    "formula",
  );
  await submit(
    keyA,
    { customer: { first_name: "Jo", last_name: "Dup", phone: "0491 570 006" } },
    "dup",
  );
  await submit(
    keyOther,
    { customer: { first_name: "Other", last_name: "Org", phone: "0491 571 266" } },
    "other",
  );
  await t.db
    .updateTable("leads")
    .set({ status: "failed", last_error_code: "mock_rejected" })
    .where("lead_ref", "=", refs["formula"]!)
    .execute();
  await t.db
    .updateTable("leads")
    .set({ status: "delivered", delivered_at: sql`now()` })
    .where("lead_ref", "=", refs["alex"]!)
    .execute();

  await createUser("super@test.local", ["super_admin"]);
  await createUser("op@test.local", ["operator"]);
  await createUser("analyst@test.local", ["analyst"]);
  await createUser("orgview@test.local", ["org_viewer"], org.id);
  admin = as((await loginAs("super@test.local")).cookie);
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false, close: true });
  await t?.destroy();
});

describe("admin authentication", () => {
  it("signs in with a secure session cookie and returns permissions", async () => {
    const { res } = await loginAs("super@test.local");
    expect(res.statusCode).toBe(200);
    const raw = String(res.headers["set-cookie"]);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Secure/i);
    const me = await admin.get("/auth/me");
    expect(me.json()).toMatchObject({ email: "super@test.local", roles: ["super_admin"] });
    expect(me.json().permissions).toContain("users.manage");
  });

  it("gives the same answer for unknown accounts and wrong passwords, and audits failures", async () => {
    const a = await loginAs("nobody@test.local");
    const b = await loginAs("op@test.local", "wrong password!!");
    expect(a.res.statusCode).toBe(401);
    expect(b.res.statusCode).toBe(401);
    expect(a.res.json().title).toBe(b.res.json().title);
    const fails = await t.db
      .selectFrom("audit_log")
      .select("detail")
      .where("action", "=", "admin.login_failed")
      .execute();
    expect(fails.length).toBeGreaterThanOrEqual(2);
  });

  it("locks an account after repeated failures and lets an admin unlock it", async () => {
    const id = await createUser("lockme@test.local", ["analyst"]);
    for (let i = 0; i < 3; i++) await loginAs("lockme@test.local", "nope nope nope");
    expect((await loginAs("lockme@test.local")).res.statusCode).toBe(401); // correct password, but locked
    expect((await admin.patch(`/users/${id}`, { unlock: true })).statusCode).toBe(200);
    expect((await loginAs("lockme@test.local")).res.statusCode).toBe(200);
  });

  it("requires a session, and the CSRF header on state-changing requests", async () => {
    expect((await app.inject({ url: "/admin/v1/leads" })).statusCode).toBe(401);
    const { cookie } = await loginAs("super@test.local");
    const noHeader = await app.inject({
      method: "POST",
      url: "/admin/v1/auth/logout",
      headers: { cookie },
    });
    expect(noHeader.statusCode).toBe(403);
    const noHeaderLogin = await app.inject({
      method: "POST",
      url: "/admin/v1/auth/login",
      payload: { email: "a", password: "b" },
    });
    expect(noHeaderLogin.statusCode).toBe(403);
  });

  it("expires idle sessions and logs out", async () => {
    const { cookie } = await loginAs("analyst@test.local");
    const s = as(cookie);
    expect((await s.get("/auth/me")).statusCode).toBe(200);
    await t.db
      .updateTable("admin_sessions")
      .set({ last_seen_at: new Date(Date.now() - 3_600_000) })
      .execute();
    expect((await s.get("/auth/me")).statusCode).toBe(401);
    admin = as((await loginAs("super@test.local")).cookie);
    const fresh = as((await loginAs("analyst@test.local")).cookie);
    expect((await fresh.post("/auth/logout")).statusCode).toBe(200);
    expect((await fresh.get("/auth/me")).statusCode).toBe(401);
  });
});

describe("leads in the admin API", () => {
  it("lists leads with personal data masked", async () => {
    const res = await admin.get("/leads?pageSize=50");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(4);
    const alex = body.items.find((i: { lead_ref: string }) => i.lead_ref === refs["alex"]);
    expect(alex).toMatchObject({
      first_name: "Alex",
      phone: "+61 ••• ••• 006",
      email: "a•••@example.com",
      platform: "PRVA",
    });
    expect(res.body).not.toContain("alex@example.com");
    expect(res.body).not.toContain("491570006");
  });

  it("filters and searches (email and phone via blind index, name, reference, status)", async () => {
    const n = async (qs: string) => (await admin.get(`/leads?${qs}`)).json().total as number;
    expect(await n("q=alex@example.com")).toBe(1);
    expect(await n(`q=${encodeURIComponent("0491 570 006")}`)).toBe(2);
    expect(await n("q=dup")).toBe(1);
    expect(await n(`q=${refs["formula"]}`)).toBe(1);
    expect(await n("status=failed")).toBe(1);
    expect(await n("problem=true")).toBe(1);
    expect(await n("platform=PRVO")).toBe(1);
    expect(await n("duplicate=true")).toBe(1);
    expect(await n("consent=awaiting_recording")).toBe(4);
    const today = new Date().toISOString().slice(0, 10);
    expect(await n(`from=2020-01-01&to=2020-01-02`)).toBe(0);
    expect(await n(`from=${today}&to=${today}&dateField=received_at`)).toBeGreaterThanOrEqual(0);
    expect((await admin.get("/leads?status=bogus")).statusCode).toBe(422);
  });

  it("shows detail masked, audits the view, and reveals personal data only with permission", async () => {
    const res = await admin.get(`/leads/${refs["dup"]}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      possible_duplicate_of: refs["alex"],
      customer: { phone: "+61 ••• ••• 006" },
    });
    expect(res.json().events.map((e: { type: string }) => e.type)).toEqual([
      "received",
      "possible_duplicate",
    ]);

    const reveal = await admin.post(`/leads/${refs["alex"]}/reveal`);
    expect(reveal.json()).toMatchObject({ email: "alex@example.com", phone: "+61491570006" });

    const analyst = as((await loginAs("analyst@test.local")).cookie);
    expect((await analyst.post(`/leads/${refs["alex"]}/reveal`)).statusCode).toBe(403);
    expect((await analyst.get(`/leads/${refs["alex"]}`)).statusCode).toBe(200);

    const actions = await t.db
      .selectFrom("audit_log")
      .select(["action", "target_id"])
      .where("target_id", "in", [refs["alex"]!, refs["dup"]!])
      .execute();
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: "lead.view", target_id: refs["dup"] },
        { action: "lead.pii_reveal", target_id: refs["alex"] },
      ]),
    );
  });

  it("lets operators retry failed leads but not analysts", async () => {
    const analyst = as((await loginAs("analyst@test.local")).cookie);
    expect((await analyst.post(`/leads/${refs["formula"]}/retry`)).statusCode).toBe(403);
    const op = as((await loginAs("op@test.local")).cookie);
    expect((await op.post(`/leads/${refs["formula"]}/retry`)).json()).toMatchObject({
      status: "queued",
    });
    expect((await op.post(`/leads/${refs["formula"]}/retry`)).statusCode).toBe(409);
    await t.db
      .updateTable("leads")
      .set({ status: "failed" })
      .where("lead_ref", "=", refs["formula"]!)
      .execute();
  });

  it("exports CSV (masked, formula-safe) and audits it", async () => {
    const res = await admin.get("/leads/export.csv?platform=PRVA");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toMatch(/^lead_ref,external_lead_id,platform/);
    expect(lines).toHaveLength(4);
    expect(res.body).toContain("'=SUM(A1)");
    expect(res.body).not.toContain("alex@example.com");
    const audit = await t.db
      .selectFrom("audit_log")
      .select("detail")
      .where("action", "=", "lead.export")
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ rows: 3 });
    const op = as((await loginAs("op@test.local")).cookie);
    expect((await op.get("/leads/export.csv")).statusCode).toBe(403);
  });

  it("lists submissions including rejections", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: { authorization: `Bearer ${keyA}` },
      payload: { schema_version: "1" },
    });
    const res = await admin.get("/submissions?outcome=rejected");
    expect(res.json().total).toBe(1);
    expect(res.json().items[0]).toMatchObject({ platform: "PRVA", http_status: 422 });
  });

  it("scopes organisation users to their own organisation's leads", async () => {
    const viewer = as((await loginAs("orgview@test.local")).cookie);
    const list = await viewer.get("/leads");
    expect(list.json().total).toBe(3);
    expect((await viewer.get(`/leads/${refs["other"]}`)).statusCode).toBe(404);
    expect((await viewer.get("/platforms")).statusCode).toBe(403);
  });
});

describe("reports", () => {
  it("summarises the period", async () => {
    const res = await admin.get("/reports/summary");
    expect(res.json().totals).toMatchObject({
      leads: 4,
      delivered: 1,
      failed: 1,
      pending: 2,
      possible_duplicates: 1,
      consent_captured: 4,
      rejected_submissions: 1,
    });
    expect(res.json().totals.delivery_rate_pct).toBe(25);
  });

  it("reports per platform and per agent, with drill-downs that match the lead list", async () => {
    const res = await admin.get("/reports/platforms");
    const a = res.json().items.find((i: { platform: string }) => i.platform === "PRVA");
    expect(a).toMatchObject({ leads: 3, delivered: 1, failed: 1, rejected_submissions: 1 });
    const drill = await admin.get(`/leads?${a.drilldown}`);
    expect(drill.json().total).toBe(a.leads);

    const agents = (await admin.get("/reports/agents")).json().items;
    const ag = agents.find((i: { platform: string }) => i.platform === "PRVA");
    expect(ag).toMatchObject({ external_agent_id: "AG-1", leads: 3 });
    expect((await admin.get(`/leads?${ag.drilldown}`)).json().total).toBe(3);

    const daily = (await admin.get("/reports/platforms?groupBy=day")).json().items;
    const day = daily.find((i: { platform: string }) => i.platform === "PRVA");
    expect(day.period_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await admin.get(`/leads?${day.drilldown}`)).json().total).toBe(day.leads);
  });

  it("is not available without reports.read", async () => {
    const op = as((await loginAs("op@test.local")).cookie);
    expect((await op.get("/reports/summary")).statusCode).toBe(403);
  });
});

describe("management", () => {
  it("creates a platform, issues a working key once, and revokes it", async () => {
    expect(
      (
        await admin.post("/platforms", {
          organisation: "org",
          code: "NEWP1",
          display_name: "New one",
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await admin.post("/platforms", { organisation: "org", code: "NEWP1", display_name: "Dup" }))
        .statusCode,
    ).toBe(409);
    // Two organisations exist and this admin belongs to none: the organisation must be given.
    const noOrg = await admin.post("/platforms", { code: "NEWP2", display_name: "No org" });
    expect(noOrg.statusCode).toBe(422);
    expect(noOrg.body).toContain("organisation");
    expect(
      (
        await admin.post("/platforms", {
          organisation: "missing",
          code: "NEWP2",
          display_name: "Unknown org",
        })
      ).statusCode,
    ).toBe(422);
    const issued = await admin.post("/platforms/NEWP1/keys", { label: "first" });
    expect(issued.statusCode).toBe(201);
    const token = issued.json().token as string;
    const ping = () =>
      app.inject({ url: "/v1/ping", headers: { authorization: `Bearer ${token}` } });
    expect((await ping()).statusCode).toBe(200);
    const keys = (await admin.get("/platforms/NEWP1/keys")).json().items;
    expect(JSON.stringify(keys)).not.toContain(token.slice(-20));
    expect((await admin.del(`/platforms/NEWP1/keys/${issued.json().prefix}`)).json().revoked).toBe(
      true,
    );
    expect((await ping()).statusCode).toBe(401);
  });

  it("suspends a platform and edits its allow-list", async () => {
    expect((await admin.patch("/platforms/PRVO", { status: "suspended" })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/v1/ping", headers: { authorization: `Bearer ${keyOther}` } }))
        .statusCode,
    ).toBe(403);
    await admin.patch("/platforms/PRVO", { status: "active" });
    expect(
      (await admin.patch("/platforms/PRVO", { allowed_cidrs: ["not-an-ip"] })).statusCode,
    ).toBe(422);
  });

  it("updates agents and tests destinations without contacting HubSpot", async () => {
    const agent = (await admin.get("/agents")).json().items[0];
    expect(
      (await admin.patch(`/agents/${agent.id}`, { destination_owner_id: "12345" })).statusCode,
    ).toBe(200);
    const dests = (await admin.get("/destinations")).json();
    expect(dests.hubspot_enabled).toBe(false);
    const test = await admin.post(`/destinations/${dests.items[0].id}/test`);
    expect(test.json().ok).toBe(true);
  });

  it("creates users with a one-time password and protects the current admin", async () => {
    const created = await admin.post("/users", {
      email: "New.Person@test.local",
      name: "New",
      roles: ["operator"],
    });
    expect(created.statusCode).toBe(201);
    const pw = created.json().temporary_password as string;
    expect(pw.length).toBe(20);
    expect((await loginAs("new.person@test.local", pw)).res.statusCode).toBe(200);
    const users = (await admin.get("/users")).json().items;
    expect(JSON.stringify(users)).not.toContain("password");
    const me = users.find((u: { email: string }) => u.email === "super@test.local");
    expect((await admin.patch(`/users/${me.id}`, { status: "disabled" })).statusCode).toBe(409);
    const op = as((await loginAs("op@test.local")).cookie);
    expect((await op.get("/users")).statusCode).toBe(403);
  });

  it("rate-limits sign-in attempts per IP", async () => {
    const strict = await buildApp({
      config: { ...t.config, ADMIN_LOGIN_RATE_PER_MIN: 2 },
      db: t.db,
      boss,
      logger: false,
    });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await strict.inject({
        method: "POST",
        url: "/admin/v1/auth/login",
        remoteAddress: "192.0.2.77",
        headers: { "x-lim-admin": "1" },
        payload: { email: "x@test.local", password: "y" },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([401, 401, 429]);
    await strict.close();
  });

  it("lets a user change their own password (old one stops working)", async () => {
    await createUser("changer@test.local", ["analyst"]);
    const s = as((await loginAs("changer@test.local")).cookie);
    expect(
      (
        await s.post("/auth/change-password", {
          current_password: "wrong",
          new_password: "a much better passphrase",
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await s.post("/auth/change-password", { current_password: PW, new_password: "short" }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await s.post("/auth/change-password", {
          current_password: PW,
          new_password: "a much better passphrase",
        })
      ).statusCode,
    ).toBe(200);
    expect((await loginAs("changer@test.local")).res.statusCode).toBe(401);
    expect((await loginAs("changer@test.local", "a much better passphrase")).res.statusCode).toBe(
      200,
    );
  });

  it("shows the audit log to permitted users only", async () => {
    const res = await admin.get("/audit?action=lead.");
    expect(res.json().total).toBeGreaterThan(0);
    expect(res.json().items.every((i: { action: string }) => i.action.startsWith("lead."))).toBe(
      true,
    );
    const analyst = as((await loginAs("analyst@test.local")).cookie);
    expect((await analyst.get("/audit")).statusCode).toBe(403);
  });
});

describe("lead-provider portal logins", () => {
  let keyB: string;
  let refB: string;
  let providerB: ReturnType<typeof as>;
  let providerBUserId: string;
  let providerBPassword: string;

  beforeAll(async () => {
    // Second provider in the SAME organisation as PRVA, sending the same customer as "alex".
    const org = await t.db
      .selectFrom("organisations")
      .select("id")
      .where("slug", "=", "org")
      .executeTakeFirstOrThrow();
    const pB = await createPlatform(
      t.db,
      { organisationId: org.id, code: "PRVB", displayName: "B", rateLimitPerMin: 5000 },
      actor,
    );
    keyB = (await issueApiCredential(t.db, { platformId: pB.id, envTag: "test" }, actor)).token;
    refB = await submit(
      keyB,
      {
        customer: {
          first_name: "Alex",
          last_name: "Again",
          phone: "0491 570 006",
          email: "alex@example.com",
        },
      },
      "b1",
    );
    await t.db
      .updateTable("leads")
      .set({
        last_error_code: "hubspot_400_validation_error",
        destination_ids: JSON.stringify({ contactId: "999" }),
      })
      .where("lead_ref", "=", refB)
      .execute();

    const created = await admin.post("/platforms/PRVB/users", {
      email: "Portal.B@provider.test",
      name: "Provider B user",
    });
    expect(created.statusCode).toBe(201);
    providerBUserId = created.json().id;
    providerBPassword = created.json().temporary_password;
    providerB = as((await loginAs("portal.b@provider.test", providerBPassword)).cookie);
  });

  it("identifies the user as a provider with the provider role", async () => {
    const me = (await providerB.get("/auth/me")).json();
    expect(me).toMatchObject({ platform: "PRVB", roles: ["provider_viewer"] });
    expect(me.permissions).toEqual([
      "leads.export",
      "leads.read",
      "recordings.read",
      "reports.read",
    ]);
  });

  it("sees only its own provider's leads, even within the same organisation", async () => {
    const list = (await providerB.get("/leads?pageSize=100")).json();
    expect(list.total).toBe(1);
    expect(list.items[0].lead_ref).toBe(refB);
    expect((await providerB.get(`/leads/${refs["alex"]}`)).statusCode).toBe(404);
    expect((await providerB.get(`/leads?q=${refs["alex"]}`)).json().total).toBe(0);
    expect((await providerB.get(`/leads?platform=PRVA`)).json().total).toBe(0);
  });

  it("does not expose internal details or other providers' references", async () => {
    const row = (await providerB.get("/leads")).json().items[0];
    expect(row).toMatchObject({
      possible_duplicate: true,
      possible_duplicate_of: null,
      last_error_code: null,
    });
    const res = await providerB.get(`/leads/${refB}`);
    const d = res.json();
    expect(d).toMatchObject({
      possible_duplicate: true,
      possible_duplicate_of: null,
      duplicates_of_this: [],
      destination: null,
      destination_ids: {},
      last_error_code: null,
    });
    expect(res.body).not.toContain(refs["alex"]!);
    expect(res.body).not.toContain("hubspot_400");
    expect(res.body).not.toContain("999");
    expect(d.customer.email).toBe("a•••@example.com");
    // Staff still see everything for the same lead.
    const staff = (await admin.get(`/leads/${refB}`)).json();
    expect(staff.possible_duplicate_of).toBe(refs["alex"]);
  });

  it("cannot reveal, retry, manage or read the audit log", async () => {
    expect((await providerB.post(`/leads/${refB}/reveal`)).statusCode).toBe(403);
    expect((await providerB.post(`/leads/${refB}/retry`)).statusCode).toBe(403);
    for (const path of [
      "/platforms",
      "/agents",
      "/destinations",
      "/users",
      "/audit",
      "/platforms/PRVB/users",
    ]) {
      expect((await providerB.get(path)).statusCode).toBe(403);
    }
  });

  it("gets reports, submissions and exports for its own provider only", async () => {
    expect((await providerB.get("/reports/summary")).json().totals.leads).toBe(1);
    const platforms = (await providerB.get("/reports/platforms")).json().items;
    expect(platforms.map((p: { platform: string }) => p.platform)).toEqual(["PRVB"]);
    const agents = (await providerB.get("/reports/agents")).json().items;
    expect(agents.every((a: { platform: string }) => a.platform === "PRVB")).toBe(true);
    const subs = (await providerB.get("/submissions")).json().items;
    expect(subs.every((s: { platform: string }) => s.platform === "PRVB")).toBe(true);
    const csv = await providerB.get("/leads/export.csv");
    expect(csv.statusCode).toBe(200);
    expect(csv.body.trim().split("\r\n")).toHaveLength(2);
    expect(csv.body).not.toContain(refs["alex"]!);
  });

  it("is managed from the provider page: list, disable, reset password", async () => {
    const users = (await admin.get("/platforms/PRVB/users")).json().items;
    expect(users.map((u: { email: string }) => u.email)).toEqual(["portal.b@provider.test"]);
    expect((await admin.get("/platforms/PRVA/users")).json().items).toEqual([]);
    // Cannot manage a PRVB user through PRVA's page.
    expect(
      (await admin.patch(`/platforms/PRVA/users/${providerBUserId}`, { status: "disabled" }))
        .statusCode,
    ).toBe(404);

    expect(
      (await admin.patch(`/platforms/PRVB/users/${providerBUserId}`, { status: "disabled" }))
        .statusCode,
    ).toBe(200);
    expect((await providerB.get("/auth/me")).statusCode).toBe(401);
    expect((await loginAs("portal.b@provider.test", providerBPassword)).res.statusCode).toBe(401);
    await admin.patch(`/platforms/PRVB/users/${providerBUserId}`, { status: "active" });

    const reset = await admin.post(`/platforms/PRVB/users/${providerBUserId}/reset-password`);
    expect(
      (await loginAs("portal.b@provider.test", reset.json().temporary_password)).res.statusCode,
    ).toBe(200);
    const audit = await t.db
      .selectFrom("audit_log")
      .select("action")
      .where("target_id", "=", providerBUserId)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "provider_user.created",
        "provider_user.updated",
        "provider_user.password_reset",
      ]),
    );
  });

  it("keeps provider and staff roles separate on the Users page", async () => {
    expect(
      (
        await admin.post("/users", {
          email: "x@provider.test",
          name: "X",
          roles: ["provider_viewer"],
        })
      ).statusCode,
    ).toBe(409);
    expect((await admin.patch(`/users/${providerBUserId}`, { roles: ["admin"] })).statusCode).toBe(
      409,
    );
    const opId = (
      await t.db
        .selectFrom("admin_users")
        .select("id")
        .where("email", "=", "op@test.local")
        .executeTakeFirstOrThrow()
    ).id;
    expect((await admin.patch(`/users/${opId}`, { roles: ["provider_viewer"] })).statusCode).toBe(
      409,
    );
    const list = (await admin.get("/users")).json().items;
    expect(list.find((u: { email: string }) => u.email === "portal.b@provider.test").platform).toBe(
      "PRVB",
    );
  });

  it("still lets the provider's API key see only its own leads", async () => {
    const res = await app.inject({
      url: "/v1/leads",
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(res.json().items.map((i: { lead_ref: string }) => i.lead_ref)).toEqual([refB]);
  });
});
