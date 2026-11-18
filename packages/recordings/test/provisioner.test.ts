/**
 * SftpgoProvisioner against a fake SFTPGo admin API: what is sent for each account, token handling,
 * create vs update, disable, remove, and errors. (The real SFTPGo is exercised on Railway.)
 */

import { describe, expect, it } from "vitest";
import { NoSftpServer, SftpgoProvisioner, type SftpAccountSpec } from "../src/index.js";

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

function fakeSftpgo(opts: { adminPassword?: string; expireFirstToken?: boolean } = {}) {
  const users = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  let tokens = 0;
  let expired = opts.expireFirstToken ?? false;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, auth: headers.get("authorization"), body });
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path === "/token") {
      const expected = `Basic ${Buffer.from(`admin:${opts.adminPassword ?? "pw"}`).toString("base64")}`;
      if (headers.get("authorization") !== expected) return json(401, { error: "bad creds" });
      tokens++;
      return json(200, { access_token: `tok${tokens}` });
    }
    if (expired && headers.get("authorization") === "Bearer tok1") {
      expired = false;
      return json(401, { error: "expired" });
    }
    const m = path.match(/^\/users(?:\/(.+))?$/);
    if (!m) return json(404, {});
    const name = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (method === "GET")
      return name && users.has(name) ? json(200, users.get(name)) : json(404, {});
    if (method === "POST") {
      users.set(String(body!.username), body!);
      return json(201, body);
    }
    if (method === "PUT") {
      if (!name || !users.has(name)) return json(404, {});
      users.set(name, body!);
      return json(200, { message: "updated" });
    }
    if (method === "DELETE") return users.delete(name!) ? json(200, {}) : json(404, {});
    return json(405, {});
  }) as typeof fetch;
  return { users, calls, fetchImpl, tokens: () => tokens };
}

const make = (fake: ReturnType<typeof fakeSftpgo>, adminPassword = "pw") =>
  new SftpgoProvisioner({
    apiUrl: "http://sftpgo.internal:8080/",
    adminUser: "admin",
    adminPassword,
    storage: {
      endpoint: "http://bucket.internal",
      region: "auto",
      accessKeyId: "AK",
      secretAccessKey: "SECRET",
      forcePathStyle: true,
      bucket: "uploads",
    },
    maxUploadBytes: 50 * 1024 * 1024,
    fetchImpl: fake.fetchImpl,
  });

const keySpec: SftpAccountSpec = {
  username: "prv01",
  enabled: true,
  authMethod: "key",
  passwordHash: null,
  publicKeys: ["ssh-ed25519 AAAAC3Nza test"],
};
const pwSpec: SftpAccountSpec = {
  username: "prv02",
  enabled: true,
  authMethod: "password",
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
  publicKeys: [],
};

describe("SftpgoProvisioner", () => {
  it("creates a key account: upload-only, bucket prefix, SFTP only, size limit", async () => {
    const fake = fakeSftpgo();
    await make(fake).upsert(keySpec);
    const u = fake.users.get("prv01")!;
    expect(u).toMatchObject({
      username: "prv01",
      status: 1,
      public_keys: keySpec.publicKeys,
      permissions: { "/": ["list", "upload", "rename_files"] },
      filesystem: {
        provider: 1,
        s3config: {
          bucket: "uploads",
          key_prefix: "prv01/",
          endpoint: "http://bucket.internal",
          force_path_style: true,
          access_secret: { status: "Plain", payload: "SECRET" },
        },
      },
      filters: { denied_protocols: ["FTP", "DAV", "HTTP"], max_upload_file_size: 52_428_800 },
    });
    expect(u).not.toHaveProperty("password");
    expect((u.filters as { denied_login_methods: string[] }).denied_login_methods).toContain(
      "password",
    );
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /token",
      "GET /users/prv01",
      "POST /users",
    ]);
  });

  it("puts uploads under a folder when the bucket is shared", async () => {
    const fake = fakeSftpgo();
    const p = new SftpgoProvisioner({
      apiUrl: "http://sftpgo.internal:8080",
      adminUser: "admin",
      adminPassword: "pw",
      storage: {
        endpoint: "http://bucket.internal",
        region: "auto",
        accessKeyId: "AK",
        secretAccessKey: "SECRET",
        forcePathStyle: true,
        bucket: "shared",
        prefix: "uploads/",
      },
      maxUploadBytes: 1,
      fetchImpl: fake.fetchImpl,
    });
    await p.upsert(keySpec);
    expect(fake.users.get("prv01")).toMatchObject({
      filesystem: { s3config: { bucket: "shared", key_prefix: "uploads/prv01/" } },
    });
  });

  it("sends only the password hash and allows only password login for password accounts", async () => {
    const fake = fakeSftpgo();
    await make(fake).upsert(pwSpec);
    const u = fake.users.get("prv02")!;
    expect(u.password).toBe(pwSpec.passwordHash);
    expect(u.public_keys).toEqual([]);
    expect((u.filters as { denied_login_methods: string[] }).denied_login_methods).toContain(
      "publickey",
    );
  });

  it("updates an existing account, disables it, and removes it", async () => {
    const fake = fakeSftpgo();
    const p = make(fake);
    await p.upsert(keySpec);
    await p.upsert({ ...keySpec, enabled: false });
    expect(fake.calls.at(-1)).toMatchObject({ method: "PUT", path: "/users/prv01" });
    expect(await p.state("prv01")).toEqual({ exists: true, enabled: false });
    await p.remove("prv01");
    expect(await p.state("prv01")).toEqual({ exists: false, enabled: false });
    await p.remove("prv01"); // already gone: fine
  });

  it("reuses its token and fetches a new one when it expires", async () => {
    const fake = fakeSftpgo({ expireFirstToken: true });
    const p = make(fake);
    await p.upsert(keySpec);
    await p.state("prv01");
    expect(fake.tokens()).toBe(2);
    expect(
      fake.calls.filter((c) => c.path !== "/token").every((c) => c.auth?.startsWith("Bearer")),
    ).toBe(true);
  });

  it("reports a wrong admin password and rejects invalid usernames", async () => {
    const fake = fakeSftpgo({ adminPassword: "right" });
    await expect(make(fake, "wrong").state("prv01")).rejects.toThrow("sftpgo_auth_failed");
    await expect(make(fakeSftpgo()).upsert({ ...keySpec, username: "../x" })).rejects.toThrow(
      "invalid_username",
    );
  });

  it("without an SFTP server, refuses to push and reports no state", async () => {
    const none = new NoSftpServer();
    await expect(none.upsert()).rejects.toThrow("sftp_not_configured");
    expect(await none.state()).toBeNull();
  });
});
