/**
 * Organisations, source platforms and their API credentials.
 * Every state change is written to the audit log in the same transaction.
 */

import { sql, type Kysely } from "kysely";
import { generateApiKey, type ApiKeyEnvTag } from "@lim/core";
import type { Database, Organisation, Platform } from "../schema.js";
import { writeAudit } from "./audit.js";

/** Who performed an action, for the audit trail. */
export interface Actor {
  type: "admin" | "system";
  id?: string | null;
  label?: string | null;
  requestId?: string | null;
  ip?: string | null;
}

const auditActor = (a: Actor) => ({
  actorType: a.type,
  actorId: a.id ?? null,
  actorLabel: a.label ?? null,
  requestId: a.requestId ?? null,
  ip: a.ip ?? null,
});

export async function createOrganisation(
  db: Kysely<Database>,
  input: { name: string; slug: string },
  actor: Actor,
): Promise<Organisation> {
  return db.transaction().execute(async (trx) => {
    const org = await trx
      .insertInto("organisations")
      .values({ name: input.name, slug: input.slug })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...auditActor(actor),
      organisationId: org.id,
      action: "organisation.created",
      targetType: "organisation",
      targetId: org.id,
      detail: { slug: org.slug },
    });
    return org;
  });
}

export async function findOrganisationBySlug(db: Kysely<Database>, slug: string) {
  return db.selectFrom("organisations").selectAll().where("slug", "=", slug).executeTakeFirst();
}

export interface CreatePlatformInput {
  organisationId: string;
  code: string;
  displayName: string;
  rateLimitPerMin?: number | null;
  allowedCidrs?: string[];
}

export async function createPlatform(
  db: Kysely<Database>,
  input: CreatePlatformInput,
  actor: Actor,
): Promise<Platform> {
  return db.transaction().execute(async (trx) => {
    const platform = await trx
      .insertInto("platforms")
      .values({
        organisation_id: input.organisationId,
        code: input.code,
        display_name: input.displayName,
        rate_limit_per_min: input.rateLimitPerMin ?? null,
        allowed_cidrs: input.allowedCidrs ?? [],
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...auditActor(actor),
      organisationId: platform.organisation_id,
      action: "platform.created",
      targetType: "platform",
      targetId: platform.id,
      detail: { code: platform.code },
    });
    return platform;
  });
}

export async function findPlatformByCode(db: Kysely<Database>, code: string) {
  return db.selectFrom("platforms").selectAll().where("code", "=", code).executeTakeFirst();
}

export async function listPlatforms(db: Kysely<Database>) {
  return db
    .selectFrom("platforms")
    .innerJoin("organisations", "organisations.id", "platforms.organisation_id")
    .select([
      "platforms.id",
      "platforms.code",
      "platforms.display_name",
      "platforms.status",
      "platforms.rate_limit_per_min",
      "platforms.allowed_cidrs",
      "organisations.slug as organisation_slug",
    ])
    .orderBy("platforms.code")
    .execute();
}

export async function setPlatformStatus(
  db: Kysely<Database>,
  platformId: string,
  status: "active" | "suspended",
  actor: Actor,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const p = await trx
      .updateTable("platforms")
      .set({ status })
      .where("id", "=", platformId)
      .returning(["id", "organisation_id", "code"])
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...auditActor(actor),
      organisationId: p.organisation_id,
      action: status === "suspended" ? "platform.suspended" : "platform.activated",
      targetType: "platform",
      targetId: p.id,
      detail: { code: p.code },
    });
  });
}

export async function updatePlatformAccess(
  db: Kysely<Database>,
  platformId: string,
  input: { allowedCidrs?: string[]; rateLimitPerMin?: number | null },
  actor: Actor,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const p = await trx
      .updateTable("platforms")
      .set({
        ...(input.allowedCidrs !== undefined ? { allowed_cidrs: input.allowedCidrs } : {}),
        ...(input.rateLimitPerMin !== undefined
          ? { rate_limit_per_min: input.rateLimitPerMin }
          : {}),
      })
      .where("id", "=", platformId)
      .returning(["id", "organisation_id", "code", "allowed_cidrs", "rate_limit_per_min"])
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...auditActor(actor),
      organisationId: p.organisation_id,
      action: "platform.updated",
      targetType: "platform",
      targetId: p.id,
      detail: {
        code: p.code,
        allowed_cidrs: p.allowed_cidrs,
        rate_limit_per_min: p.rate_limit_per_min,
      },
    });
  });
}

export interface IssuedCredential {
  credentialId: string;
  prefix: string;
  /** Full API key: shown to the operator once, never stored. */
  token: string;
  expiresAt: Date | null;
}

export async function issueApiCredential(
  db: Kysely<Database>,
  input: {
    platformId: string;
    envTag: ApiKeyEnvTag;
    label?: string | null;
    expiresAt?: Date | null;
  },
  actor: Actor,
): Promise<IssuedCredential> {
  const key = generateApiKey(input.envTag);
  return db.transaction().execute(async (trx) => {
    const platform = await trx
      .selectFrom("platforms")
      .select(["id", "organisation_id", "code"])
      .where("id", "=", input.platformId)
      .executeTakeFirstOrThrow();
    const cred = await trx
      .insertInto("platform_api_credentials")
      .values({
        platform_id: platform.id,
        env_tag: input.envTag,
        key_prefix: key.prefix,
        key_hash: key.hash,
        label: input.label ?? null,
        expires_at: input.expiresAt ?? null,
        created_by: actor.type === "admin" ? (actor.id ?? null) : null,
      })
      .returning(["id", "expires_at"])
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...auditActor(actor),
      organisationId: platform.organisation_id,
      action: "platform.credential_issued",
      targetType: "platform_api_credential",
      targetId: cred.id,
      detail: {
        platform: platform.code,
        prefix: key.prefix,
        env: input.envTag,
        label: input.label ?? null,
      },
    });
    return {
      credentialId: cred.id,
      prefix: key.prefix,
      token: key.token,
      expiresAt: cred.expires_at,
    };
  });
}

export async function revokeApiCredential(
  db: Kysely<Database>,
  prefix: string,
  actor: Actor,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const cred = await trx
      .updateTable("platform_api_credentials")
      .set({ revoked_at: sql<Date>`now()` })
      .where("key_prefix", "=", prefix)
      .where("revoked_at", "is", null)
      .returning(["id", "platform_id"])
      .executeTakeFirst();
    if (!cred) return false;
    const platform = await trx
      .selectFrom("platforms")
      .select(["organisation_id", "code"])
      .where("id", "=", cred.platform_id)
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...auditActor(actor),
      organisationId: platform.organisation_id,
      action: "platform.credential_revoked",
      targetType: "platform_api_credential",
      targetId: cred.id,
      detail: { platform: platform.code, prefix },
    });
    return true;
  });
}

export async function listApiCredentials(db: Kysely<Database>, platformId: string) {
  return db
    .selectFrom("platform_api_credentials")
    .select([
      "id",
      "key_prefix",
      "env_tag",
      "label",
      "created_at",
      "last_used_at",
      "expires_at",
      "revoked_at",
    ])
    .where("platform_id", "=", platformId)
    .orderBy("created_at", "desc")
    .execute();
}

/** Everything the auth hook needs, in one query by key prefix. */
export async function findCredentialForAuth(db: Kysely<Database>, prefix: string) {
  return db
    .selectFrom("platform_api_credentials as c")
    .innerJoin("platforms as p", "p.id", "c.platform_id")
    .innerJoin("organisations as o", "o.id", "p.organisation_id")
    .select([
      "c.id as credential_id",
      "c.env_tag",
      "c.key_hash",
      "c.expires_at",
      "c.revoked_at",
      "c.last_used_at",
      "p.id as platform_id",
      "p.code as platform_code",
      "p.status as platform_status",
      "p.allowed_cidrs",
      "p.rate_limit_per_min",
      "p.organisation_id",
      "o.status as organisation_status",
    ])
    .where("c.key_prefix", "=", prefix)
    .executeTakeFirst();
}

/** Refreshes last_used_at at most once per `throttleSeconds` to avoid a write per request. */
export async function touchCredential(
  db: Kysely<Database>,
  credentialId: string,
  throttleSeconds: number,
): Promise<void> {
  await db
    .updateTable("platform_api_credentials")
    .set({ last_used_at: sql<Date>`now()` })
    .where("id", "=", credentialId)
    .where((eb) =>
      eb.or([
        eb("last_used_at", "is", null),
        eb("last_used_at", "<", sql<Date>`now() - make_interval(secs => ${throttleSeconds})`),
      ]),
    )
    .execute();
}
