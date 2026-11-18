import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrganisation,
  createPlatform,
  issueApiCredential,
  touchServiceStatus,
  type Actor,
} from "@lim/db";
import type { PgBoss } from "@lim/jobs";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/admin/auth.js";
import { runRetentionPurge } from "../../worker/src/handlers/recordings.js";
import { createTestDatabase, startTestBoss, type TestDatabase } from "../../../test/helpers.js";

const actor: Actor = { type: "system", label: "test" };
const PW = "correct horse battery staple";
let t: TestDatabase;
let app: FastifyInstance;
let boss: PgBoss;
let key: string;

const cookieOf = (res: LightMyRequestResponse) => {
  const c = res.cookies.find((x) => x.name === "lim_admin_session");
  return c ? `lim_admin_session=${c.value}` : "";
};
async function login(email: string, roles: string[]) {
  const u = await t.db
    .insertInto("admin_users")
    .values({
      email,
      name: email,
      auth_provider: "local",
      password_hash: await hashPassword(PW),
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await t.db
    .insertInto("admin_user_roles")
    .values(roles.map((role_code) => ({ user_id: u.id, role_code })))
    .execute();
  const res = await app.inject({
    method: "POST",
    url: "/admin/v1/auth/login",
    headers: { "x-lim-admin": "1" },
    payload: { email, password: PW },
  });
  const cookie = cookieOf(res);
  return (url: string) => app.inject({ url: `/admin/v1${url}`, headers: { cookie } });
}
const submit = async (ext: string, email: string) => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/leads",
    headers: { authorization: `Bearer ${key}` },
    payload: {
      schema_version: "1",
      external_lead_id: ext,
      transferred_at: new Date(Date.now() - 60_000).toISOString(),
      customer: {
        first_name: "Retain",
        last_name: "Me",
        phone: "0491 572 549",
        email,
        address: { line1: "9 Example St", postcode: "2000", state: "NSW", country: "AU" },
      },
      agent: { external_id: "AG-1" },
      consent: { verbal_consent: true },
      notes: "private note",
    },
  });
  return res.json().lead_ref as string;
};

beforeAll(async () => {
  t = await createTestDatabase({
    config: {
      RATE_LIMIT_IP_PER_MIN: "5000",
      ADMIN_LOGIN_RATE_PER_MIN: "1000",
      ADMIN_RATE_PER_MIN: "100000",
      PAYLOAD_RETENTION_DAYS: "30",
    },
  });
  boss = await startTestBoss(t);
  app = await buildApp({ config: t.config, db: t.db, boss, logger: false });
  await app.ready();
  const org = await createOrganisation(t.db, { name: "Org", slug: "org" }, actor);
  const p = await createPlatform(
    t.db,
    { organisationId: org.id, code: "PRVA", displayName: "A", rateLimitPerMin: 5000 },
    actor,
  );
  key = (await issueApiCredential(t.db, { platformId: p.id, envTag: "test" }, actor)).token;
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false, close: true });
  await t?.destroy();
});

describe("retention", () => {
  it("anonymises leads past retention, keeps reporting fields, and purges old payloads", async () => {
    const expired = await submit("RET-1", "retain.me@example.com");
    const recent = await submit("RET-2", "keep.me@example.com");
    const old = await submit("RET-3", "old.payload@example.com");
    await sql`UPDATE leads SET retention_until = now() - interval '1 day' WHERE lead_ref = ${expired}`.execute(
      t.db,
    );
    await sql`UPDATE submissions SET received_at = now() - interval '40 days' WHERE external_lead_id = 'RET-3'`.execute(
      t.db,
    );

    const log = pino({ level: "silent" });
    const result = await runRetentionPurge({ db: t.db, config: t.config, log, boss });
    expect(result).toEqual({ recordings: 0, leads: 1, payloads: 1 });

    const admin = await login("ops@test.local", ["super_admin"]);
    const gone = (await admin(`/leads/${expired}`)).json();
    expect(gone.customer).toMatchObject({
      first_name: "[removed]",
      last_name: "[removed]",
      email: null,
      has_address: false,
      has_notes: false,
    });
    expect(gone.customer.location).toMatchObject({ state: "NSW", postcode: "2000" });
    expect(gone.events.map((e: { type: string }) => e.type)).toContain("personal_data_removed");
    expect((await admin("/leads?q=retain.me%40example.com")).json().total).toBe(0);
    expect((await admin("/leads?q=keep.me%40example.com")).json().total).toBe(1);

    const payloads = await t.db
      .selectFrom("submissions")
      .select(["external_lead_id", "payload_enc"])
      .orderBy("external_lead_id")
      .execute();
    expect(payloads.map((p) => [p.external_lead_id, p.payload_enc === null])).toEqual([
      ["RET-1", true],
      ["RET-2", false],
      ["RET-3", true],
    ]);
    const audit = await t.db
      .selectFrom("audit_log")
      .select("action")
      .where("actor_label", "=", "retention-purge")
      .execute();
    expect(audit.map((a) => a.action).sort()).toEqual([
      "lead.anonymised",
      "submission.payloads_purged",
    ]);
    expect(recent && old).toBeTruthy();
    const status = await t.db
      .selectFrom("service_status")
      .selectAll()
      .where("name", "=", "retention-purge")
      .executeTakeFirstOrThrow();
    expect(status.detail).toEqual({ recordings: 0, leads: 1, payloads: 1 });
  });
});

describe("system status", () => {
  it("reports services, queues and items needing attention to administrators only", async () => {
    const admin = await login("sys@test.local", ["admin"]);
    let res = (await admin("/system")).json();
    expect(res.services.database).toEqual({ ok: true, migrations_current: true });
    expect(res.services.worker.ok).toBe(false); // no heartbeat yet
    expect(res.queues.map((q: { name: string }) => q.name)).toContain("deliver-lead");
    expect(res.attention).toMatchObject({ in_flight: 3, anonymised: 1 });

    await touchServiceStatus(t.db, "worker", {});
    res = (await admin("/system")).json();
    expect(res.services.worker.ok).toBe(true);

    const analyst = await login("an@test.local", ["analyst"]);
    expect((await analyst("/system")).statusCode).toBe(403);
  });
});
