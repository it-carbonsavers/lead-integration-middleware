import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import ssh2 from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decrypt, QUEUES } from "@lim/core";
import {
  createDestination,
  createOrganisation,
  createPlatform,
  issueApiCredential,
  type Actor,
} from "@lim/db";
import type { PgBoss } from "@lim/jobs";
import { ingestRecording, LocalEncryptedStore, makeTestWav } from "@lim/recordings";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/admin/auth.js";
import { deliverLead } from "../../worker/src/handlers/deliver-lead.js";
import { syncConsent } from "../../worker/src/handlers/recordings.js";
import { createTestDatabase, startTestBoss, type TestDatabase } from "../../../test/helpers.js";

const actor: Actor = { type: "system", label: "test" };
const PW = "correct horse battery staple";
let t: TestDatabase;
let app: FastifyInstance;
let boss: PgBoss;
let store: LocalEncryptedStore;
let keyA: string;
let pA: { id: string };
let pB: { id: string };
let staff: ReturnType<typeof as>;
let provider: ReturnType<typeof as>;

const cookieOf = (res: LightMyRequestResponse) => {
  const c = res.cookies.find((x) => x.name === "lim_admin_session");
  return c ? `lim_admin_session=${c.value}` : "";
};
const as = (cookie: string) => ({
  get: (url: string) => app.inject({ method: "GET", url: `/admin/v1${url}`, headers: { cookie } }),
  post: (url: string, payload?: object) =>
    app.inject({
      method: "POST",
      url: `/admin/v1${url}`,
      headers: { cookie, "x-lim-admin": "1" },
      payload: payload ?? {},
    }),
  put: (url: string, payload: object) =>
    app.inject({
      method: "PUT",
      url: `/admin/v1${url}`,
      headers: { cookie, "x-lim-admin": "1" },
      payload,
    }),
  upload: (query: string, file: Buffer) =>
    app.inject({
      method: "POST",
      url: `/admin/v1/recordings/upload?${query}`,
      headers: { cookie, "x-lim-admin": "1", "content-type": "application/octet-stream" },
      payload: file,
    }),
});
async function user(
  email: string,
  roles: string[],
  platformId: string | null = null,
  orgId: string | null = null,
) {
  const u = await t.db
    .insertInto("admin_users")
    .values({
      email,
      name: email,
      auth_provider: "local",
      password_hash: await hashPassword(PW),
      status: "active",
      platform_id: platformId,
      organisation_id: orgId,
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
  return as(cookieOf(res));
}
const ingest = (platformId: string, name: string, freq: number) =>
  ingestRecording(
    { db: t.db, store, maxBytes: 1_000_000, retentionDays: 30 },
    {
      platformId,
      mode: "sftp_hosted",
      remotePath: name,
      fileName: name,
      size: 0,
      mtime: new Date(1_700_000_000_000 + freq),
      data: makeTestWav(0.2, freq),
    },
  ).then((o) => ({ ...o, size: 0 }));

beforeAll(async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "lim-rec-store-"));
  t = await createTestDatabase({
    config: {
      RATE_LIMIT_IP_PER_MIN: "5000",
      ADMIN_LOGIN_RATE_PER_MIN: "1000",
      ADMIN_RATE_PER_MIN: "100000",
      RECORDING_STORAGE_DIR: storeDir,
    },
  });
  store = new LocalEncryptedStore(storeDir, t.config.APP_ENCRYPTION_KEY);
  boss = await startTestBoss(t);
  app = await buildApp({ config: t.config, db: t.db, boss, logger: false });
  await app.ready();
  const org = await createOrganisation(t.db, { name: "Org", slug: "org" }, actor);
  await createDestination(
    t.db,
    { type: "mock", name: "Mock", isDefault: true, config: {}, credentialRef: "NONE_REQUIRED" },
    actor,
  );
  pA = await createPlatform(
    t.db,
    { organisationId: org.id, code: "PRVA", displayName: "A", rateLimitPerMin: 5000 },
    actor,
  );
  pB = await createPlatform(
    t.db,
    { organisationId: org.id, code: "PRVB", displayName: "B", rateLimitPerMin: 5000 },
    actor,
  );
  keyA = (await issueApiCredential(t.db, { platformId: pA.id, envTag: "test" }, actor)).token;
  staff = await user("ops@test.local", ["super_admin"]);
  provider = await user("prov.b@test.local", ["provider_viewer"], pB.id, org.id);
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false, close: true });
  await t?.destroy();
});

describe("recordings in the admin API", () => {
  let refA: string;
  let orphanId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: { authorization: `Bearer ${keyA}` },
      payload: {
        schema_version: "1",
        external_lead_id: "EXT-A1",
        transferred_at: new Date(Date.now() - 60_000).toISOString(),
        customer: { first_name: "Alex", last_name: "Example", phone: "0491 570 006" },
        agent: { external_id: "AG-1" },
        consent: { verbal_consent: true, recording_ref: "REC-A1" },
      },
    });
    refA = res.json().lead_ref;
    await ingest(pA.id, "REC-A1.wav", 400);
    orphanId = ((await ingest(pA.id, "UNKNOWN-1.wav", 410)) as { recordingId: string }).recordingId;
    await ingest(pB.id, "B-ONLY.wav", 420);
  });

  it("lists recordings for staff, and only the provider's own for provider users", async () => {
    const all = (await staff.get("/recordings")).json();
    expect(all.total).toBe(3);
    const mine = (await provider.get("/recordings")).json();
    expect(mine.items.map((r: { original_filename: string }) => r.original_filename)).toEqual([
      "B-ONLY.wav",
    ]);
    expect(
      (await provider.get("/transfers"))
        .json()
        .items.every((x: { platform: string }) => x.platform === "PRVB"),
    ).toBe(true);
  });

  it("shows recordings on the lead and streams audio only with permission (audited)", async () => {
    const lead = (await staff.get(`/leads/${refA}`)).json();
    expect(lead.consent.status).toBe("matched");
    expect(lead.recordings).toHaveLength(1);
    const audio = await staff.get(`/recordings/${lead.recordings[0].id}/audio`);
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
    const played = await t.db
      .selectFrom("audit_log")
      .select("action")
      .where("target_id", "=", lead.recordings[0].id)
      .execute();
    expect(played.map((a) => a.action)).toContain("recording.played");
    const theirs = (await provider.get("/recordings")).json().items[0].id;
    expect((await provider.get(`/recordings/${theirs}/audio`)).statusCode).toBe(403);
  });

  it("links an unmatched recording to a lead (same provider only)", async () => {
    expect(
      (await provider.post(`/recordings/${orphanId}/link`, { lead_ref: refA })).statusCode,
    ).toBe(403);
    expect((await staff.post(`/recordings/${orphanId}/link`, { lead_ref: refA })).json()).toEqual({
      ok: true,
    });
    expect((await staff.post(`/recordings/${orphanId}/link`, { lead_ref: refA })).statusCode).toBe(
      409,
    );
    const jobs = await boss.findJobs<{ leadId: string }>(QUEUES.syncConsent.name);
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("queues a scan on request (staff only)", async () => {
    expect((await staff.post("/transfers/scan")).json()).toMatchObject({ queued: true });
    expect((await provider.post("/transfers/scan")).statusCode).toBe(403);
  });

  it("validates and stores provider SFTP settings without echoing keys", async () => {
    const key = ssh2.utils.generateKeyPairSync("ed25519").public;
    expect(
      (
        await staff.put("/platforms/PRVA/sftp", {
          mode: "sftp_hosted",
          username: "prva",
          authorized_keys: ["not a key at all, really not"],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await staff.put("/platforms/PRVA/sftp", {
          mode: "sftp_hosted",
          username: "prva",
          authorized_keys: [key],
        })
      ).statusCode,
    ).toBe(200);
    const got = await staff.get("/platforms/PRVA/sftp");
    expect(got.json().mode).toBe("sftp_hosted");
    expect(got.json().config.authorized_keys[0].fingerprint).toMatch(/^SHA256:/);
    expect(got.body).not.toContain(key.split(" ")[1]!);
    expect(
      (
        await staff.put("/platforms/PRVB/sftp", {
          mode: "sftp_hosted",
          username: "prva",
          authorized_keys: [key],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await staff.put("/platforms/PRVB/sftp", {
          mode: "sftp_pull",
          host: "sftp.provider.example",
          remote_username: "lim",
          remote_path: "/outbox",
          host_key_fingerprint: "md5:aa",
          credential_ref: "pull_prvb",
        })
      ).statusCode,
    ).toBe(422);
    expect((await staff.put("/platforms/PRVB/sftp", { mode: "none" })).statusCode).toBe(200);
    expect((await provider.get("/platforms/PRVB/sftp")).statusCode).toBe(403);
  });
});

describe("uploading recordings in the portal", () => {
  it("lets a provider upload for its own source only, with the same checks as SFTP", async () => {
    const wav = makeTestWav(0.4, 611);
    const ok = await provider.upload("filename=PORTAL-REF-1.wav", wav);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ file: "PORTAL-REF-1.wav", result: "not_matched" });
    // The same bytes again: recognised as already received.
    expect((await provider.upload("filename=PORTAL-REF-1-again.wav", wav)).json()).toMatchObject({
      result: "duplicate",
    });
    // Not audio: rejected with the reason.
    const fake = await provider.upload("filename=FAKE.wav", Buffer.from("not audio at all"));
    expect(fake.statusCode).toBe(422);
    expect(fake.json()).toMatchObject({ result: "rejected" });
    // A path in the name is reduced to the file name.
    expect(
      (await provider.upload("filename=..%2F..%2Fescape.wav", makeTestWav(0.3, 612))).json(),
    ).toMatchObject({ file: "escape.wav" });
    // Another source's code is refused, an empty body too.
    expect((await provider.upload("filename=X.wav&platform=PRVA", wav)).statusCode).toBe(404);
    expect((await provider.upload("filename=EMPTY.wav", Buffer.alloc(0))).statusCode).toBe(422);

    const files = (await provider.get("/recordings?pageSize=50")).json().items as {
      original_filename: string;
      platform: string;
    }[];
    expect(files.map((f) => f.original_filename)).toEqual(
      expect.arrayContaining(["PORTAL-REF-1.wav", "FAKE.wav", "escape.wav"]),
    );
    expect(new Set(files.map((f) => f.platform))).toEqual(new Set(["PRVB"]));
    const transfers = (await provider.get("/transfers?pageSize=50")).json().items as {
      mode: string;
    }[];
    expect(transfers.some((x) => x.mode === "portal_upload")).toBe(true);
  });

  it("requires staff to choose the source, and the upload permission", async () => {
    expect((await staff.upload("filename=S.wav", makeTestWav(0.3, 613))).statusCode).toBe(422);
    expect(
      (await staff.upload("filename=S.wav&platform=PRVA", makeTestWav(0.3, 613))).json(),
    ).toMatchObject({ result: "not_matched" });
    const analyst = await user("analyst.up@test.local", ["analyst"]);
    expect(
      (await analyst.upload("filename=A.wav&platform=PRVA", makeTestWav(0.3, 614))).statusCode,
    ).toBe(403);
  });
});

describe("consent status sync to the destination", () => {
  it("updates the delivered lead at the mock destination when its recording is matched", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/leads",
      headers: { authorization: `Bearer ${keyA}` },
      payload: {
        schema_version: "1",
        external_lead_id: "EXT-SYNC",
        transferred_at: new Date(Date.now() - 60_000).toISOString(),
        customer: { first_name: "Sam", last_name: "Sample", phone: "0491 570 156" },
        agent: { external_id: "AG-1" },
        consent: { verbal_consent: true, recording_ref: "REC-SYNC" },
      },
    });
    const ref = res.json().lead_ref as string;
    const lead = await t.db
      .selectFrom("leads")
      .select("id")
      .where("lead_ref", "=", ref)
      .executeTakeFirstOrThrow();
    const log = pino({ level: "silent" });
    await deliverLead(
      { db: t.db, config: t.config, log },
      { id: "j1", retryCount: 0, data: { leadId: lead.id } },
    );
    await ingest(pA.id, "REC-SYNC.wav", 430);
    expect(await syncConsent({ db: t.db, config: t.config, log, boss }, lead.id)).toBe("synced");
    const rec = await t.db
      .selectFrom("mock_destination_records")
      .select("payload_enc")
      .where("lead_ref", "=", ref)
      .executeTakeFirstOrThrow();
    const payload = JSON.parse(decrypt(rec.payload_enc, t.config.APP_ENCRYPTION_KEY));
    expect(payload.lead.properties.lim_consent_status).toBe("matched");
  });
});
