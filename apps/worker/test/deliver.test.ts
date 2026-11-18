import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decrypt, QUEUES } from "@lim/core";
import {
  createDestination,
  createOrganisation,
  createPlatform,
  issueApiCredential,
  setPlatformDestination,
  type Actor,
} from "@lim/db";
import { createBoss, ensureQueues, type DeliverLeadJob, type PgBoss } from "@lim/jobs";
import { buildApp } from "../../api/src/app.js";
import { requeueLead } from "../../api/src/services/lead-ops.js";
import { deliverLead, type DeliverDeps } from "../src/handlers/deliver-lead.js";
import { createTestDatabase, startTestBoss, type TestDatabase } from "../../../test/helpers.js";
import { FakeHubSpot } from "../../../test/fake-hubspot.js";

const actor: Actor = { type: "system", label: "test" };
const log = pino({ level: "silent" });
let t: TestDatabase;
let app: FastifyInstance;
let boss: PgBoss;
let key: string;
let platformId: string;
let mockDestinationId: string;
let hubspotDestinationId: string;
let seq = 0;

const lead = (extra?: Record<string, unknown>) => ({
  schema_version: "1",
  external_lead_id: `W-${++seq}`,
  transferred_at: new Date(Date.now() - 60_000).toISOString(),
  customer: {
    first_name: "Alex",
    last_name: "Example",
    phone: "0491 570 006",
    email: `alex${seq}@example.com`,
  },
  agent: { external_id: "AG-9", name: "Agent Nine" },
  consent: { verbal_consent: true },
  ...(extra ? { extra } : {}),
});

async function submit(body: unknown): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/leads",
    headers: { authorization: `Bearer ${key}` },
    payload: body as object,
  });
  expect(res.statusCode).toBe(202);
  return res.json().lead_ref as string;
}

const leadId = async (ref: string) =>
  (
    await t.db
      .selectFrom("leads")
      .select("id")
      .where("lead_ref", "=", ref)
      .executeTakeFirstOrThrow()
  ).id;
const leadRow = (ref: string) =>
  t.db.selectFrom("leads").selectAll().where("lead_ref", "=", ref).executeTakeFirstOrThrow();
const job = async (ref: string, retryCount = 0) => ({
  id: `job-${ref}-${retryCount}`,
  retryCount,
  data: { leadId: await leadId(ref) },
});
const deps = (over: Partial<DeliverDeps> = {}): DeliverDeps => ({
  db: t.db,
  config: t.config,
  log,
  ...over,
});

beforeAll(async () => {
  t = await createTestDatabase({
    config: {
      RATE_LIMIT_IP_PER_MIN: "1000",
      DELIVERY_RETRY_LIMIT: "2",
      DELIVERY_RETRY_DELAY_SECONDS: "1",
      DELIVERY_RETRY_DELAY_MAX_SECONDS: "1",
    },
  });
  boss = await startTestBoss(t);
  app = await buildApp({ config: t.config, db: t.db, boss, logger: false });
  await app.ready();
  const org = await createOrganisation(t.db, { name: "Org", slug: "org" }, actor);
  const p = await createPlatform(
    t.db,
    { organisationId: org.id, code: "PRV01", displayName: "P1", rateLimitPerMin: 1000 },
    actor,
  );
  platformId = p.id;
  key = (await issueApiCredential(t.db, { platformId: p.id, envTag: "test" }, actor)).token;
  mockDestinationId = (
    await createDestination(
      t.db,
      { type: "mock", name: "Mock", isDefault: true, config: {}, credentialRef: "NONE_REQUIRED" },
      actor,
    )
  ).id;
  hubspotDestinationId = (
    await createDestination(
      t.db,
      {
        type: "hubspot",
        name: "HubSpot",
        isDefault: false,
        config: {},
        credentialRef: "HUBSPOT_PRIVATE_APP_TOKEN",
      },
      actor,
    )
  ).id;
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false, close: true });
  await t?.destroy();
});

describe("deliverLead with the local mock destination", () => {
  it("delivers, records the attempt and timeline, and stores what would have been sent (encrypted)", async () => {
    const ref = await submit(lead());
    expect(await deliverLead(deps(), await job(ref))).toBe("delivered");

    const row = await leadRow(ref);
    expect(row.status).toBe("delivered");
    expect(row.delivered_at).not.toBeNull();
    expect(row.destination_id).toBe(mockDestinationId);
    expect(row.destination_ids).toMatchObject({
      contactId: expect.stringMatching(/^mock-contact-/),
      leadId: `mock-lead-${ref}`,
    });

    const attempts = await t.db
      .selectFrom("delivery_attempts")
      .selectAll()
      .where("lead_id", "=", row.id)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt_no: 1,
      status: "success",
      step_results: { contact: "created", lead: "created" },
    });

    const events = await t.db
      .selectFrom("lead_events")
      .select(["type", "to_status"])
      .where("lead_id", "=", row.id)
      .orderBy("id")
      .execute();
    expect(events.map((e) => e.type)).toEqual(["received", "delivery_started", "delivered"]);

    const rec = await t.db
      .selectFrom("mock_destination_records")
      .selectAll()
      .where("lead_ref", "=", ref)
      .executeTakeFirstOrThrow();
    expect(rec.payload_enc.toString("utf8")).not.toContain("example.com");
    const payload = JSON.parse(decrypt(rec.payload_enc, t.config.APP_ENCRYPTION_KEY));
    expect(payload.contact.properties).toMatchObject({ firstname: "Alex", phone: "+61491570006" });
    expect(payload.lead.properties).toMatchObject({
      lim_lead_ref: ref,
      hs_pipeline: "lead-pipeline-id",
      lim_agent_external_id: "AG-9",
    });
  });

  it("recognises the same customer as an existing mock contact", async () => {
    const body = lead();
    const first = await submit(body);
    await deliverLead(deps(), await job(first));
    const second = await submit({ ...lead(), customer: body.customer });
    await deliverLead(deps(), await job(second));
    const a = await t.db
      .selectFrom("delivery_attempts")
      .select("step_results")
      .where("lead_id", "=", await leadId(second))
      .executeTakeFirstOrThrow();
    expect(a.step_results).toMatchObject({ contact: "found" });
    expect((await leadRow(second)).destination_ids["contactId"]).toBe(
      (await leadRow(first)).destination_ids["contactId"],
    );
  });

  it("skips a lead that is already delivered (no double delivery)", async () => {
    const ref = await submit(lead());
    await deliverLead(deps(), await job(ref));
    expect(await deliverLead(deps(), await job(ref))).toBe("skipped");
    const n = await t.db
      .selectFrom("delivery_attempts")
      .select("id")
      .where("lead_id", "=", await leadId(ref))
      .execute();
    expect(n).toHaveLength(1);
  });

  it("retries a retryable failure and then succeeds (fail_once)", async () => {
    const ref = await submit(lead({ simulate: "fail_once" }));
    await expect(deliverLead(deps(), await job(ref, 0))).rejects.toMatchObject({
      code: "mock_unavailable",
    });
    let row = await leadRow(ref);
    expect(row.status).toBe("retry_scheduled");
    expect(row.last_error_code).toBe("mock_unavailable");

    expect(await deliverLead(deps(), await job(ref, 1))).toBe("delivered");
    row = await leadRow(ref);
    expect(row.status).toBe("delivered");
    expect(row.last_error_code).toBeNull();
    const attempts = await t.db
      .selectFrom("delivery_attempts")
      .select(["attempt_no", "status", "error_code"])
      .where("lead_id", "=", row.id)
      .orderBy("attempt_no")
      .execute();
    expect(attempts).toEqual([
      { attempt_no: 1, status: "retryable_error", error_code: "mock_unavailable" },
      { attempt_no: 2, status: "success", error_code: null },
    ]);
  });

  it("marks permanent failures as failed without retrying", async () => {
    const ref = await submit(lead({ simulate: "permanent_error" }));
    expect(await deliverLead(deps(), await job(ref))).toBe("failed");
    const row = await leadRow(ref);
    expect(row.status).toBe("failed");
    expect(row.last_error_code).toBe("mock_rejected");
  });

  it("dead-letters after the retry limit", async () => {
    const ref = await submit(lead({ simulate: "retryable_error" }));
    await expect(deliverLead(deps(), await job(ref, 0))).rejects.toThrow();
    await expect(deliverLead(deps(), await job(ref, 1))).rejects.toThrow();
    await expect(deliverLead(deps(), await job(ref, 2))).rejects.toThrow();
    const row = await leadRow(ref);
    expect(row.status).toBe("dead_letter");
    expect(row.attempt_count).toBe(3);
  });

  it("can be re-queued by an operator after failing, with an audit entry", async () => {
    const ref = await submit(lead({ simulate: "permanent_error" }));
    await deliverLead(deps(), await job(ref));
    await requeueLead(t.db, boss, ref, actor);
    expect((await leadRow(ref)).status).toBe("queued");
    const audit = await t.db
      .selectFrom("audit_log")
      .select("action")
      .where("target_id", "=", ref)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(["lead.retry_requested"]);
    await expect(requeueLead(t.db, boss, ref, actor)).rejects.toThrow(/only failed or dead_letter/);
  });

  it("fails clearly when no destination is active", async () => {
    await t.db
      .updateTable("destinations")
      .set({ status: "disabled" })
      .where("id", "=", mockDestinationId)
      .execute();
    try {
      const ref = await submit(lead());
      expect(await deliverLead(deps(), await job(ref))).toBe("failed");
      expect((await leadRow(ref)).last_error_code).toBe("no_destination");
    } finally {
      await t.db
        .updateTable("destinations")
        .set({ status: "active" })
        .where("id", "=", mockDestinationId)
        .execute();
    }
  });
});

describe("deliverLead with the HubSpot destination", () => {
  it("does not call HubSpot while HUBSPOT_ENABLED is false", async () => {
    await setPlatformDestination(t.db, platformId, hubspotDestinationId, actor);
    const fake = new FakeHubSpot();
    try {
      const ref = await submit(lead());
      const outcome = await deliverLead(
        deps({ adapterDeps: { fetch: fake.fetch, env: { HUBSPOT_PRIVATE_APP_TOKEN: "x" } } }),
        await job(ref),
      );
      expect(outcome).toBe("failed");
      expect((await leadRow(ref)).last_error_code).toBe("hubspot_disabled");
      expect(fake.calls).toHaveLength(0);
    } finally {
      await setPlatformDestination(t.db, platformId, null, actor);
    }
  });

  it("delivers Contact + Lead through the adapter when enabled (fake HubSpot, no network)", async () => {
    await setPlatformDestination(t.db, platformId, hubspotDestinationId, actor);
    const fake = new FakeHubSpot();
    try {
      const ref = await submit(lead());
      const outcome = await deliverLead(
        deps({
          config: { ...t.config, HUBSPOT_ENABLED: true, HUBSPOT_BASE_URL: "https://hubspot.fake" },
          adapterDeps: {
            fetch: fake.fetch,
            env: { HUBSPOT_PRIVATE_APP_TOKEN: "fake-token" },
            sleep: async () => {},
          },
        }),
        await job(ref),
      );
      expect(outcome).toBe("delivered");
      expect(fake.contacts).toHaveLength(1);
      expect(fake.leads).toHaveLength(1);
      const row = await leadRow(ref);
      expect(row.destination_ids).toEqual({
        contactId: fake.contacts[0]!.id,
        leadId: fake.leads[0]!.id,
      });
    } finally {
      await setPlatformDestination(t.db, platformId, null, actor);
    }
  });
});

describe("end to end through pg-boss", () => {
  it("API submission is picked up by a worker, retried after a simulated outage, and delivered", async () => {
    const worker = createBoss(t.config, { poolMax: 2 });
    await worker.start();
    await ensureQueues(worker, t.config);
    await worker.work<DeliverLeadJob>(
      QUEUES.deliverLead.name,
      { batchSize: 1, pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const j of jobs) await deliverLead(deps(), j);
      },
    );
    try {
      const ok = await submit(lead());
      const flaky = await submit(lead({ simulate: "fail_once" }));
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const [a, b] = await Promise.all([leadRow(ok), leadRow(flaky)]);
        if (a.status === "delivered" && b.status === "delivered") break;
        await new Promise((r) => setTimeout(r, 300));
      }
      expect((await leadRow(ok)).status).toBe("delivered");
      const flakyRow = await leadRow(flaky);
      expect(flakyRow.status).toBe("delivered");
      expect(flakyRow.attempt_count).toBe(2);
    } finally {
      await worker.stop({ graceful: false, close: true });
    }
  }, 40_000);
});
