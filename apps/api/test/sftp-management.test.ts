import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import ssh2 from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganisation, createPlatform, issueApiCredential, type Actor } from "@lim/db";
import type { PgBoss } from "@lim/jobs";
import {
  ingestRecording,
  LocalEncryptedStore,
  makeTestWav,
  scanHostedUploads,
  type AccountProvisioner,
  type SftpAccountSpec,
  type SftpRuntime,
} from "@lim/recordings";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/admin/auth.js";
import { MemoryInbox } from "../../../test/memory-inbox.js";
import { createTestDatabase, startTestBoss, type TestDatabase } from "../../../test/helpers.js";

const fingerprintOf = (pub: string) => {
  const k = ssh2.utils.parseKey(pub);
  const key = Array.isArray(k) ? k[0] : k;
  if (!key || key instanceof Error) throw new Error("bad key");
  return `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
};
const actor: Actor = { type: "system", label: "test" };
const PW = "correct horse battery staple";
const host = ssh2.utils.generateKeyPairSync("ed25519");
const providerKey = ssh2.utils.generateKeyPairSync("ed25519");

// Stands in for SFTPGo's admin API: records what the middleware pushes.
const pushed: SftpAccountSpec[] = [];
const removed: string[] = [];
const accounts = new Map<string, boolean>();
let sftpgoDown = false;
const provisioner: AccountProvisioner = {
  kind: "sftpgo",
  async upsert(spec) {
    if (sftpgoDown) throw new Error("connection refused");
    pushed.push(spec);
    accounts.set(spec.username, spec.enabled);
  },
  async remove(username) {
    removed.push(username);
    accounts.delete(username);
  },
  async state(username) {
    return accounts.has(username)
      ? { exists: true, enabled: accounts.get(username)! }
      : { exists: false, enabled: false };
  },
};
const rt: SftpRuntime = { backend: "sftpgo", inbox: null, provisioner, host: "127.0.0.1", port: 1 };
const lastPush = () => pushed[pushed.length - 1]!;

let t: TestDatabase;
let app: FastifyInstance;
let boss: PgBoss;
let sftpPort: number;
let server: InstanceType<typeof ssh2.Server>;
const inbox = new MemoryInbox();
let admin: ReturnType<typeof as>;
let adminCookie: string;
let key: string;

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
});

beforeAll(async () => {
  rt.inbox = inbox;
  // Stands in for SFTPGo's SFTP port: only the SSH handshake is used here (reachability and
  // host-key fingerprint); every login is refused.
  server = new ssh2.Server({ hostKeys: [host.private] }, (client) => {
    client.on("authentication", (ctx) => ctx.reject());
    client.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  sftpPort = (server.address() as AddressInfo).port;

  t = await createTestDatabase({
    config: {
      RATE_LIMIT_IP_PER_MIN: "5000",
      ADMIN_LOGIN_RATE_PER_MIN: "1000",
      ADMIN_RATE_PER_MIN: "100000",
      RECORDING_STORAGE_DIR: await mkdtemp(join(tmpdir(), "lim-store-")),
    },
  });
  boss = await startTestBoss(t);
  app = await buildApp({ config: t.config, db: t.db, boss, logger: false, sftp: rt });
  await app.ready();
  const org = await createOrganisation(t.db, { name: "Org", slug: "org" }, actor);
  for (const code of ["SRCA", "SRCB", "SRCC"]) {
    const p = await createPlatform(
      t.db,
      { organisationId: org.id, code, displayName: code, rateLimitPerMin: 5000 },
      actor,
    );
    if (code === "SRCC")
      key = (await issueApiCredential(t.db, { platformId: p.id, envTag: "test" }, actor)).token;
  }
  const u = await t.db
    .insertInto("admin_users")
    .values({
      email: "ops@test.local",
      name: "Ops",
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
  const res = await app.inject({
    method: "POST",
    url: "/admin/v1/auth/login",
    headers: { "x-lim-admin": "1" },
    payload: { email: "ops@test.local", password: PW },
  });
  adminCookie = cookieOf(res);
  admin = as(adminCookie);
});

afterAll(async () => {
  server?.close();
  await app?.close();
  await boss?.stop({ graceful: false, close: true });
  await t?.destroy();
});

describe("SFTP account settings", () => {
  it("issues a password once, stores only a hash, and can issue a new one", async () => {
    const res = await admin.put("/platforms/SRCA/sftp", {
      mode: "sftp_hosted",
      username: "srca",
      auth_method: "password",
    });
    expect(res.statusCode).toBe(200);
    const pw = res.json().generated_password as string;
    expect(pw).toHaveLength(20);
    // Pushed to the SFTP server as a hash only.
    expect(lastPush()).toMatchObject({ username: "srca", authMethod: "password", enabled: true });
    expect(lastPush().passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(pushed)).not.toContain(pw);
    const row = await t.db
      .selectFrom("platform_sftp_configs")
      .select(["password_hash"])
      .executeTakeFirstOrThrow();
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    const got = await admin.get("/platforms/SRCA/sftp");
    expect(got.json().config).toMatchObject({
      auth_method: "password",
      password_set: true,
      username: "srca",
    });
    expect(got.body).not.toContain(pw);
    expect(got.body).not.toContain("argon2");
    // Saving again keeps the existing password (no new one shown).
    expect(
      (
        await admin.put("/platforms/SRCA/sftp", {
          mode: "sftp_hosted",
          username: "srca",
          auth_method: "password",
        })
      ).json().generated_password,
    ).toBeUndefined();
    const before = lastPush().passwordHash;
    const again = await admin.post("/platforms/SRCA/sftp/password");
    expect(again.json().generated_password).not.toBe(pw);
    expect(lastPush().passwordHash).not.toBe(before);
    expect(
      (await admin.get("/platforms/SRCA/sftp")).json().config.account_synced_at,
    ).not.toBeNull();
  });

  it("requires a valid public key for key login and reports when our server is unreachable", async () => {
    expect(
      (
        await admin.put("/platforms/SRCA/sftp", {
          mode: "sftp_hosted",
          username: "srca",
          auth_method: "key",
          authorized_keys: [],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await admin.put("/platforms/SRCA/sftp", {
          mode: "sftp_hosted",
          username: "srca",
          auth_method: "key",
          authorized_keys: [providerKey.private],
        })
      ).statusCode,
    ).toBe(422);
    const test = await admin.post("/platforms/SRCA/sftp/test");
    expect(test.json()).toMatchObject({ ok: false, error: "server_unreachable" });
    expect((await admin.get("/platforms/SRCA/sftp")).json().config.last_error).toBe(
      "server_unreachable",
    );
  });
});

describe("SFTP server accounts (SFTPGo)", () => {
  const keyBody = (username = "srca") => ({
    mode: "sftp_hosted",
    username,
    auth_method: "key",
    authorized_keys: [providerKey.public],
  });

  it("pushes key accounts, tests the set-up and shows our server's fingerprint", async () => {
    rt.port = sftpPort;
    expect((await admin.put("/platforms/SRCA/sftp", keyBody())).json()).toEqual({ ok: true });
    expect(lastPush()).toMatchObject({
      username: "srca",
      authMethod: "key",
      publicKeys: [providerKey.public],
    });
    inbox.add("srca", "WAITING-1.wav", makeTestWav(0.2));
    inbox.add("srca", "BIG.wav.filepart", makeTestWav(0.2));
    expect((await admin.post("/platforms/SRCA/sftp/test")).json()).toMatchObject({
      ok: true,
      files_waiting: 1,
    });
    const got = (await admin.get("/platforms/SRCA/sftp")).json();
    expect(got.config).toMatchObject({ last_error: null });
    expect(got.config.last_success_at).not.toBeNull();
    expect(got.our_server).toMatchObject({
      server: "SFTPGo",
      host: "127.0.0.1",
      port: sftpPort,
      host_key_fingerprint: fingerprintOf(host.public),
      host_key_fingerprints: [{ type: "ED25519", fingerprint: fingerprintOf(host.public) }],
    });
  });

  it("disables the account while the source is suspended", async () => {
    const patch = (status: string) =>
      app.inject({
        method: "PATCH",
        url: "/admin/v1/platforms/SRCA",
        headers: { cookie: adminCookie, "x-lim-admin": "1" },
        payload: { status },
      });
    expect((await patch("suspended")).statusCode).toBe(200);
    expect(lastPush()).toMatchObject({ username: "srca", enabled: false });
    expect((await patch("active")).statusCode).toBe(200);
    expect(lastPush()).toMatchObject({ username: "srca", enabled: true });
  });

  it("removes the old account when the username changes, and when SFTP is switched off", async () => {
    await admin.put("/platforms/SRCB/sftp", keyBody("srcb-old"));
    await admin.put("/platforms/SRCB/sftp", keyBody("srcb"));
    expect(removed).toContain("srcb-old");
    expect(accounts.has("srcb")).toBe(true);
    expect((await admin.put("/platforms/SRCB/sftp", { mode: "none" })).statusCode).toBe(200);
    expect(removed).toContain("srcb");
  });

  it("keeps the settings and reports it when the SFTP server cannot be updated", async () => {
    sftpgoDown = true;
    const res = await admin.put("/platforms/SRCA/sftp", keyBody());
    expect(res.statusCode).toBe(200);
    expect(res.json().account_sync_error).toMatch(/could not be updated/);
    expect((await admin.get("/platforms/SRCA/sftp")).json().config.last_error).toBe(
      "account_sync_failed",
    );
    expect((await admin.post("/platforms/SRCA/sftp/test")).json()).toMatchObject({
      ok: false,
      error: "account_sync_failed",
    });
    sftpgoDown = false;
    expect((await admin.post("/platforms/SRCA/sftp/test")).json().ok).toBe(true);
    expect((await admin.get("/platforms/SRCA/sftp")).json().config.last_error).toBeNull();
  });

  it("no longer accepts the 'we collect from the provider' option", async () => {
    const res = await admin.put("/platforms/SRCB/sftp", {
      mode: "sftp_pull",
      host: "sftp.provider.example",
      remote_username: "lim",
      remote_path: "/outbox",
      host_key_fingerprint: fingerprintOf(host.public),
      password: "x".repeat(12),
    });
    expect(res.statusCode).toBe(422);
  });

  it("picks up the waiting upload and leaves unfinished ones", async () => {
    const deps = {
      db: t.db,
      store: new LocalEncryptedStore(t.config.RECORDING_STORAGE_DIR!, t.config.APP_ENCRYPTION_KEY),
      maxBytes: 1_000_000,
      retentionDays: 30,
    };
    const [s] = await scanHostedUploads(deps, rt.inbox!);
    expect(s).toMatchObject({ platform: "SRCA", seen: 1, stored: 1 });
    expect(await rt.inbox!.list("srca")).toEqual([]);
    expect((await admin.get("/platforms/SRCA/sftp")).json().transfers.stored).toBe(1);
  });
});

describe("transfers and consent workflow", () => {
  it("retries only failed transfers", async () => {
    const job = await t.db.selectFrom("transfer_jobs").select("id").executeTakeFirstOrThrow();
    expect((await admin.post(`/transfers/${job.id}/retry`)).statusCode).toBe(409);
    await t.db
      .updateTable("transfer_jobs")
      .set({ status: "failed", error_code: "processing_error" })
      .where("id", "=", job.id)
      .execute();
    expect((await admin.post(`/transfers/${job.id}/retry`)).json()).toEqual({
      ok: true,
      queued: true,
    });
    expect((await admin.post("/transfers/scan", { platform: "SRCA" })).json()).toMatchObject({
      queued: true,
    });
  });

  it("shows each lead's consent workflow and the overview figures", async () => {
    const submit = (ext: string, verbal: boolean) =>
      app.inject({
        method: "POST",
        url: "/v1/leads",
        headers: { authorization: `Bearer ${key}` },
        payload: {
          schema_version: "1",
          external_lead_id: ext,
          transferred_at: new Date(Date.now() - 60_000).toISOString(),
          customer: { first_name: "Flow", last_name: ext, phone: "0491 573 770" },
          agent: { external_id: "AG-F" },
          consent: { verbal_consent: verbal, ...(verbal ? { recording_ref: `REF-${ext}` } : {}) },
        },
      });
    const waiting = (await submit("WF-1", true)).json().lead_ref;
    const done = (await submit("WF-2", true)).json().lead_ref;
    const none = (await submit("WF-3", false)).json().lead_ref;
    const srcc = await t.db
      .selectFrom("platforms")
      .select("id")
      .where("code", "=", "SRCC")
      .executeTakeFirstOrThrow();
    await ingestRecording(
      {
        db: t.db,
        store: new LocalEncryptedStore(
          t.config.RECORDING_STORAGE_DIR!,
          t.config.APP_ENCRYPTION_KEY,
        ),
        maxBytes: 1_000_000,
        retentionDays: 30,
      },
      {
        platformId: srcc.id,
        mode: "sftp_hosted",
        remotePath: "REF-WF-2.wav",
        fileName: "REF-WF-2.wav",
        size: 1,
        mtime: new Date(),
        data: makeTestWav(0.2, 700),
      },
    );

    const states = async (ref: string) =>
      (await admin.get(`/leads/${ref}`))
        .json()
        .consent_workflow.map((s: { state: string }) => s.state);
    expect(await states(waiting)).toEqual([
      "done",
      "done",
      "done",
      "current",
      "waiting",
      "waiting",
    ]);
    expect(await states(done)).toEqual(["done", "done", "done", "done", "done", "done"]); // not delivered yet: CRM gets it on delivery
    expect(await states(none)).toEqual([
      "done",
      "done",
      "not_applicable",
      "not_applicable",
      "not_applicable",
      "not_applicable",
    ]);

    const list = (await admin.get("/consent?view=needs_recording")).json();
    expect(list.items.map((i: { lead_ref: string }) => i.lead_ref)).toEqual([waiting]);
    expect(list.items[0].stage).toMatchObject({ key: "transferred", state: "current" });
    const summary = (await admin.get("/consent/summary")).json();
    expect(summary).toMatchObject({ awaiting: 1, matched: 1 });

    const overview = (await admin.get("/overview?days=30")).json();
    expect(overview.totals).toMatchObject({ received: 3, consent_pending: 1 });
    expect(overview.by_source[0]).toMatchObject({ code: "SRCC", leads: 3 });
    expect(overview.recent).toHaveLength(3);

    const sources = (await admin.get("/platforms")).json().items;
    expect(sources.find((s: { code: string }) => s.code === "SRCC")).toMatchObject({
      leads_30d: 3,
    });
    expect(sources.find((s: { code: string }) => s.code === "SRCA")).toMatchObject({
      recording_ingest_mode: "sftp_hosted",
    });
  });
});
