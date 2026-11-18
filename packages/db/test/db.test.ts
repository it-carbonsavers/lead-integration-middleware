import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS, verifyApiKeySecret, parseApiKey } from "@lim/core";
import {
  createOrganisation,
  createPlatform,
  findCredentialForAuth,
  issueApiCredential,
  isSchemaCurrent,
  listApiCredentials,
  migrateDown,
  migrateToLatest,
  migrationStatus,
  revokeApiCredential,
  setPlatformStatus,
  updatePlatformAccess,
  type Actor,
} from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "../../../test/helpers.js";

const actor: Actor = { type: "system", label: "test" };
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.destroy();
});

describe("migrations", () => {
  it("are all applied and reversible", async () => {
    expect(await isSchemaCurrent(t.db)).toBe(true);
    const down = await migrateDown(t.db);
    expect(down.error).toBeUndefined();
    expect(await isSchemaCurrent(t.db)).toBe(false);
    const up = await migrateToLatest(t.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(t.db)).every((m) => m.executedAt)).toBe(true);
  });

  it("seed the roles and permissions", async () => {
    const roles = await t.db.selectFrom("roles").select("code").execute();
    expect(roles.map((r) => r.code).sort()).toEqual([
      "admin",
      "analyst",
      "compliance",
      "operator",
      "org_viewer",
      "provider_viewer",
      "super_admin",
    ]);
    const superPerms = await t.db
      .selectFrom("role_permissions")
      .select("permission")
      .where("role_code", "=", "super_admin")
      .execute();
    expect(superPerms.length).toBe(PERMISSIONS.length);
  });
});

describe("platforms and credentials", () => {
  it("creates organisation and platform with audit entries", async () => {
    const org = await createOrganisation(t.db, { name: "Test Org", slug: "test-org" }, actor);
    const p = await createPlatform(
      t.db,
      {
        organisationId: org.id,
        code: "PRV01",
        displayName: "Provider 01",
        allowedCidrs: ["203.0.113.0/24"],
      },
      actor,
    );
    expect(p.allowed_cidrs).toEqual(["203.0.113.0/24"]);
    expect(p.status).toBe("active");

    const audit = await t.db.selectFrom("audit_log").selectAll().orderBy("id").execute();
    expect(audit.map((a) => a.action)).toEqual(["organisation.created", "platform.created"]);
    expect(audit[1]!.actor_label).toBe("test");
  });

  it("rejects invalid platform codes at the database level", async () => {
    const org = await t.db.selectFrom("organisations").select("id").executeTakeFirstOrThrow();
    await expect(
      createPlatform(t.db, { organisationId: org.id, code: "bad code", displayName: "x" }, actor),
    ).rejects.toThrow();
  });

  it("issues a key whose secret is stored only as a hash, and revokes it", async () => {
    const p = await t.db
      .selectFrom("platforms")
      .selectAll()
      .where("code", "=", "PRV01")
      .executeTakeFirstOrThrow();
    const issued = await issueApiCredential(
      t.db,
      { platformId: p.id, envTag: "test", label: "primary" },
      actor,
    );
    const parsed = parseApiKey(issued.token)!;

    const row = await t.db
      .selectFrom("platform_api_credentials")
      .selectAll()
      .where("id", "=", issued.credentialId)
      .executeTakeFirstOrThrow();
    expect(row.key_prefix).toBe(parsed.prefix);
    expect(JSON.stringify(row)).not.toContain(parsed.secret);
    expect(verifyApiKeySecret(parsed.secret, row.key_hash)).toBe(true);

    const forAuth = await findCredentialForAuth(t.db, parsed.prefix);
    expect(forAuth?.platform_code).toBe("PRV01");
    expect(forAuth?.allowed_cidrs).toEqual(["203.0.113.0/24"]);

    expect(await revokeApiCredential(t.db, parsed.prefix, actor)).toBe(true);
    expect(await revokeApiCredential(t.db, parsed.prefix, actor)).toBe(false);
    const list = await listApiCredentials(t.db, p.id);
    expect(list[0]!.revoked_at).not.toBeNull();

    const actions = await t.db.selectFrom("audit_log").select("action").orderBy("id").execute();
    expect(actions.map((a) => a.action)).toContain("platform.credential_issued");
    expect(actions.map((a) => a.action)).toContain("platform.credential_revoked");
    // Audit detail never holds the key itself.
    const details = await t.db.selectFrom("audit_log").select("detail").execute();
    expect(JSON.stringify(details)).not.toContain(parsed.secret);
  });

  it("updates status and access with audit", async () => {
    const p = await t.db
      .selectFrom("platforms")
      .selectAll()
      .where("code", "=", "PRV01")
      .executeTakeFirstOrThrow();
    await setPlatformStatus(t.db, p.id, "suspended", actor);
    await updatePlatformAccess(t.db, p.id, { allowedCidrs: [], rateLimitPerMin: 10 }, actor);
    const after = await t.db
      .selectFrom("platforms")
      .selectAll()
      .where("id", "=", p.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("suspended");
    expect(after.allowed_cidrs).toEqual([]);
    expect(after.rate_limit_per_min).toBe(10);
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(after.created_at.getTime());
  });
});

describe("audit log", () => {
  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await expect(sql`UPDATE audit_log SET action = 'tampered'`.execute(t.db)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`DELETE FROM audit_log`.execute(t.db)).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE audit_log`.execute(t.db)).rejects.toThrow(/append-only/);
  });

  it("allows deletion only inside an explicit retention purge transaction", async () => {
    const before = await t.db
      .selectFrom("audit_log")
      .select(sql<number>`count(*)::int`.as("n"))
      .executeTakeFirstOrThrow();
    await t.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lim.audit_purge = 'on'`.execute(trx);
      await sql`DELETE FROM audit_log WHERE id = (SELECT min(id) FROM audit_log)`.execute(trx);
    });
    const after = await t.db
      .selectFrom("audit_log")
      .select(sql<number>`count(*)::int`.as("n"))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n - 1);
    // The setting does not leak outside that transaction.
    await expect(sql`DELETE FROM audit_log`.execute(t.db)).rejects.toThrow(/append-only/);
  });
});
