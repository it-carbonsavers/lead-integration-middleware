import { Writable } from "node:stream";
import pino from "pino";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "@lim/config";
import { generateApiKey } from "@lim/core";
import {
  createOrganisation,
  createPlatform,
  issueApiCredential,
  revokeApiCredential,
  setPlatformStatus,
  type Actor,
} from "@lim/db";
import { buildApp } from "../src/app.js";
import { createTestDatabase, startTestBoss, type TestDatabase } from "../../../test/helpers.js";
import type { PgBoss } from "@lim/jobs";

const actor: Actor = { type: "system", label: "test" };
let t: TestDatabase;
let app: FastifyInstance;
let orgId: string;
let boss: PgBoss;

async function newPlatform(code: string, extra: { cidrs?: string[]; rate?: number } = {}) {
  const p = await createPlatform(
    t.db,
    {
      organisationId: orgId,
      code,
      displayName: code,
      allowedCidrs: extra.cidrs ?? [],
      rateLimitPerMin: extra.rate ?? null,
    },
    actor,
  );
  const key = await issueApiCredential(t.db, { platformId: p.id, envTag: "test" }, actor);
  return { platform: p, key };
}

const ping = (token?: string, remoteAddress = "127.0.0.1", headers: Record<string, string> = {}) =>
  app.inject({
    method: "GET",
    url: "/v1/ping",
    remoteAddress,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });

beforeAll(async () => {
  t = await createTestDatabase({ config: { RATE_LIMIT_IP_PER_MIN: "1000" } });
  orgId = (await createOrganisation(t.db, { name: "Org", slug: "org" }, actor)).id;
  boss = await startTestBoss(t);
  app = await buildApp({ config: t.config, db: t.db, boss, logger: false });

  // Test-only routes to exercise body parsing, validation and unexpected errors.
  const echoBody = z.strictObject({
    name: z.string().min(1),
    customer: z.object({ phone: z.string().regex(/^\+\d+$/) }),
  });
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post("/test/echo", { schema: { body: echoBody } }, async (req) => ({
    ok: true,
    name: req.body.name,
  }));
  app.get("/test/boom", async () => {
    throw new Error("connection to db-internal.example:5432 failed for user secret_user");
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false, close: true });
  await t?.destroy();
});

describe("health", () => {
  it("live and ready", async () => {
    expect((await app.inject("/health/live")).json()).toEqual({ status: "ok" });
    const ready = await app.inject("/health/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", checks: { database: true, migrations: true } });
  });

  it("reports not_ready when migrations are missing", async () => {
    const empty = await createTestDatabase({ migrate: false });
    const a = await buildApp({ config: empty.config, db: empty.db, boss, logger: false });
    const res = await a.inject("/health/ready");
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ database: true, migrations: false });
    await a.close();
    await empty.destroy();
  });
});

describe("provider authentication", () => {
  it("accepts a valid key and identifies the platform from the credential", async () => {
    const { key } = await newPlatform("AUTHOK");
    const res = await ping(key.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      authenticated: true,
      platform: "AUTHOK",
      environment: "test",
    });
    expect(res.headers["x-request-id"]).toMatch(/^req_/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("records last_used_at", async () => {
    const { key } = await newPlatform("TOUCH");
    await ping(key.token);
    const row = await t.db
      .selectFrom("platform_api_credentials")
      .select("last_used_at")
      .where("id", "=", key.credentialId)
      .executeTakeFirstOrThrow();
    expect(row.last_used_at).not.toBeNull();
  });

  it("returns the same 401 for missing, malformed, unknown, wrong-environment, revoked and expired keys", async () => {
    const { platform, key } = await newPlatform("AUTHBAD");
    const unknown = generateApiKey("test").token;
    const wrongSecret = key.token.slice(0, -1) + (key.token.endsWith("a") ? "b" : "a");
    const wrongEnv = key.token.replace("lim_test_", "lim_live_");
    const expired = await issueApiCredential(
      t.db,
      { platformId: platform.id, envTag: "test", expiresAt: new Date(Date.now() - 1000) },
      actor,
    );
    const revoked = await issueApiCredential(
      t.db,
      { platformId: platform.id, envTag: "test" },
      actor,
    );
    await revokeApiCredential(t.db, revoked.prefix, actor);

    const bodies = new Set<string>();
    for (const token of [
      undefined,
      "not-a-key",
      unknown,
      wrongSecret,
      wrongEnv,
      expired.token,
      revoked.token,
    ]) {
      const res = await ping(token);
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      const { request_id: _ignored, ...body } = res.json();
      bodies.add(JSON.stringify(body));
    }
    expect(bodies.size).toBe(1);
  });

  it("returns 403 for a suspended platform", async () => {
    const { platform, key } = await newPlatform("SUSP");
    await setPlatformStatus(t.db, platform.id, "suspended", actor);
    const res = await ping(key.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toBe("Platform is suspended");
  });

  it("enforces the platform IP allow-list", async () => {
    const { key } = await newPlatform("IPLIST", { cidrs: ["203.0.113.0/24"] });
    expect((await ping(key.token, "203.0.113.9")).statusCode).toBe(200);
    expect((await ping(key.token, "198.51.100.9")).statusCode).toBe(403);
  });

  it("ignores X-Forwarded-For unless proxy hops are configured", async () => {
    const { key } = await newPlatform("XFF", { cidrs: ["203.0.113.0/24"] });
    // Untrusted client claiming an allowed IP via header: rejected.
    expect(
      (await ping(key.token, "198.51.100.9", { "x-forwarded-for": "203.0.113.9" })).statusCode,
    ).toBe(403);

    const proxied = await buildApp({
      config: { ...t.config, TRUST_PROXY_HOPS: 1 },
      db: t.db,
      boss,
      logger: false,
    });
    const res = await proxied.inject({
      method: "GET",
      url: "/v1/ping",
      remoteAddress: "10.0.0.1", // the proxy
      headers: {
        authorization: `Bearer ${key.token}`,
        "x-forwarded-for": "198.51.100.1, 203.0.113.9",
      },
    });
    // Only the hop added by our proxy (rightmost) is trusted; the spoofed leftmost entry is ignored.
    expect(res.statusCode).toBe(200);
    await proxied.close();
  });
});

describe("rate limiting", () => {
  it("limits each platform separately and returns Retry-After", async () => {
    const a = await newPlatform("RLA", { rate: 2 });
    const b = await newPlatform("RLB", { rate: 2 });
    expect((await ping(a.key.token)).statusCode).toBe(200);
    expect((await ping(a.key.token)).statusCode).toBe(200);
    const limited = await ping(a.key.token);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.json().type).toMatch(/rate-limited$/);
    expect((await ping(b.key.token)).statusCode).toBe(200);
  });

  it("limits unauthenticated traffic per client IP", async () => {
    const strict = await buildApp({
      config: { ...t.config, RATE_LIMIT_IP_PER_MIN: 3 },
      db: t.db,
      boss,
      logger: false,
    });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push(
        (await strict.inject({ method: "GET", url: "/v1/ping", remoteAddress: "192.0.2.50" }))
          .statusCode,
      );
    }
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    await strict.close();
  });
});

describe("errors", () => {
  it("returns problem+json 404 with request id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/nope",
      headers: { "x-request-id": "trace-12345678" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["x-request-id"]).toBe("trace-12345678");
    expect(res.json()).toMatchObject({
      status: 404,
      title: "Resource not found",
      request_id: "trace-12345678",
    });
  });

  it("rejects non-JSON content types with 415", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "text/plain" },
      payload: "hi",
    });
    expect(res.statusCode).toBe(415);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/json" },
      payload: "{bad",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects oversized bodies with 413", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(70_000) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it("returns 422 with field paths and codes but never the submitted values", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      payload: { name: "", customer: { phone: "0412 SECRET" }, extra: "x" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.errors).toEqual(
      expect.arrayContaining([
        { path: "name", code: "too_small" },
        { path: "customer.phone", code: "invalid_format" },
      ]),
    );
    expect(res.body).not.toContain("SECRET");
  });

  it("hides internal error details", async () => {
    const res = await app.inject("/test/boom");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ title: "Unexpected error", status: 500 });
    expect(res.body).not.toMatch(/db-internal|secret_user|5432/);
  });
});

describe("request log serializer", () => {
  it("drops query strings (admin searches can contain e-mail addresses and phone numbers)", async () => {
    const { safeRequestSerializer } = await import("@lim/config");
    expect(
      safeRequestSerializer({
        method: "GET",
        url: "/admin/v1/leads?q=alex%40example.com",
        ip: "127.0.0.1",
      }),
    ).toEqual({
      method: "GET",
      url: "/admin/v1/leads?[query omitted]",
      remoteAddress: "127.0.0.1",
    });
    expect(safeRequestSerializer({ method: "GET", url: "/health/ready" }).url).toBe(
      "/health/ready",
    );
  });
});

describe("logging", () => {
  it("redacts credentials and personal data", () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino(loggerOptions({ LOG_LEVEL: "info", NODE_ENV: "production" }, "t"), stream);
    log.info(
      {
        req: { headers: { authorization: "Bearer lim_test_SECRET" } },
        customer: { email: "alex@example.com" },
        lead: { phone: "+61400000000", email: "a@b.c" },
      },
      "x",
    );
    const out = lines.join("");
    expect(out).not.toContain("lim_test_SECRET");
    expect(out).not.toContain("alex@example.com");
    expect(out).not.toContain("+61400000000");
    expect(out).toContain("[REDACTED]");
  });
});
