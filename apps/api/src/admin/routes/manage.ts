/**
 * Admin management endpoints (internal staff only).
 *   platforms + API keys   platforms.manage
 *   agents                 agents.manage
 *   destinations           destinations.manage
 *   users                  users.manage
 *   audit log              audit.read
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { isIP } from "node:net";
import { sql } from "kysely";
import { z } from "zod";
import { apiKeyEnvTag } from "@lim/config";
import { problems, ROLES } from "@lim/core";
import {
  createPlatform,
  issueApiCredential,
  listApiCredentials,
  listDestinations,
  revokeApiCredential,
  setDefaultDestination,
  setPlatformDestination,
  setPlatformStatus,
  updatePlatformAccess,
  writeAudit,
} from "@lim/db";
import { createAdapter } from "@lim/destinations";
import { actorOf, generatePassword, hashPassword, requirePermission } from "../auth.js";
import { dayEnd, dayStart } from "../lead-query.js";
import { syncSftpAccount } from "@lim/recordings";
import type { AdminRouteOptions } from "./index.js";
import { hubspotRouting } from "../hubspot-routing.js";

const cidr = z.string().refine((c) => {
  const [addr, bits] = c.split("/");
  const fam = isIP(addr ?? "");
  const max = fam === 6 ? 128 : 32;
  return fam > 0 && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= max));
}, "invalid CIDR");
const idParam = z.object({ id: z.uuid() });
const codeParam = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{2,15}$/) });

export async function adminManageRoutes(app: FastifyInstance, opts: AdminRouteOptions) {
  const { db, config } = opts;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const platformsPerm = requirePermission("platforms.manage", { internalOnly: true });

  // --- Platforms ---------------------------------------------------------------
  r.get("/platforms", { preHandler: platformsPerm }, async () => {
    const rows = await db
      .selectFrom("platforms as p")
      .innerJoin("organisations as o", "o.id", "p.organisation_id")
      .leftJoin("destinations as d", "d.id", "p.destination_id")
      .select([
        "p.id",
        "p.code",
        "p.display_name",
        "p.status",
        "p.rate_limit_per_min",
        "p.allowed_cidrs",
        "p.created_at",
        "o.slug as organisation",
        "d.name as destination_override",
        "p.destination_id",
        sql<number>`(SELECT count(*)::int FROM platform_api_credentials c WHERE c.platform_id = p.id AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now()))`.as(
          "active_keys",
        ),
        sql<number>`(SELECT count(*)::int FROM leads l WHERE l.platform_id = p.id)`.as(
          "lead_count",
        ),
        sql<number>`(SELECT count(*)::int FROM admin_users u WHERE u.platform_id = p.id AND u.status = 'active')`.as(
          "portal_users",
        ),
        sql<number>`(SELECT count(*)::int FROM leads l WHERE l.platform_id = p.id AND l.received_at > now() - interval '30 days')`.as(
          "leads_30d",
        ),
        sql<number>`(SELECT count(*)::int FROM leads l WHERE l.platform_id = p.id AND l.received_at > now() - interval '30 days' AND l.status = 'delivered')`.as(
          "delivered_30d",
        ),
        sql<Date | null>`(SELECT max(received_at) FROM leads l WHERE l.platform_id = p.id)`.as(
          "last_lead_at",
        ),
        sql<Date | null>`(SELECT max(last_used_at) FROM platform_api_credentials c WHERE c.platform_id = p.id)`.as(
          "last_api_use_at",
        ),
        "p.recording_ingest_mode",
        sql<Date | null>`(SELECT last_success_at FROM platform_sftp_configs s WHERE s.platform_id = p.id)`.as(
          "sftp_last_success_at",
        ),
        sql<
          string | null
        >`(SELECT last_error FROM platform_sftp_configs s WHERE s.platform_id = p.id)`.as(
          "sftp_last_error",
        ),
      ])
      .orderBy("p.code")
      .execute();
    return { items: rows, default_rate_limit: config.RATE_LIMIT_PLATFORM_DEFAULT_PER_MIN };
  });

  /** The organisation a new source belongs to: as given, else the admin's own, else the only one. */
  async function resolveOrganisation(slug: string | undefined, adminOrgId: string | null) {
    if (slug) {
      const org = await db
        .selectFrom("organisations")
        .select("id")
        .where("slug", "=", slug)
        .executeTakeFirst();
      if (!org) throw problems.validation([{ path: "organisation", code: "not_found" }]);
      return org;
    }
    if (adminOrgId) return { id: adminOrgId };
    const orgs = await db.selectFrom("organisations").select("id").limit(2).execute();
    if (orgs.length !== 1) throw problems.validation([{ path: "organisation", code: "required" }]);
    return orgs[0]!;
  }

  r.post(
    "/platforms",
    {
      preHandler: platformsPerm,
      schema: {
        body: z.strictObject({
          /** Organisation slug. Optional: defaults to the admin's organisation, or the only one. */
          organisation: z.string().min(1).optional(),
          code: z
            .string()
            .regex(/^[A-Z][A-Z0-9_]{2,15}$/, "3-16 chars: A-Z, 0-9, _ (start with a letter)"),
          display_name: z.string().trim().min(1).max(200),
          rate_limit_per_min: z.number().int().min(1).max(100_000).nullable().optional(),
          allowed_cidrs: z.array(cidr).max(50).optional(),
        }),
      },
    },
    async (req, reply) => {
      const org = await resolveOrganisation(req.body.organisation, req.admin!.organisationId);
      const exists = await db
        .selectFrom("platforms")
        .select("id")
        .where("code", "=", req.body.code)
        .executeTakeFirst();
      if (exists) throw problems.conflict("A platform with this code already exists");
      const p = await createPlatform(
        db,
        {
          organisationId: org.id,
          code: req.body.code,
          displayName: req.body.display_name,
          rateLimitPerMin: req.body.rate_limit_per_min ?? null,
          allowedCidrs: req.body.allowed_cidrs ?? [],
        },
        actorOf(req),
      );
      return reply.code(201).send({ id: p.id, code: p.code });
    },
  );

  r.patch(
    "/platforms/:code",
    {
      preHandler: platformsPerm,
      schema: {
        params: codeParam,
        body: z.strictObject({
          status: z.enum(["active", "suspended"]).optional(),
          rate_limit_per_min: z.number().int().min(1).max(100_000).nullable().optional(),
          allowed_cidrs: z.array(cidr).max(50).optional(),
          destination_id: z.uuid().nullable().optional(),
        }),
      },
    },
    async (req) => {
      const p = await db
        .selectFrom("platforms")
        .selectAll()
        .where("code", "=", req.params.code)
        .executeTakeFirst();
      if (!p) throw problems.notFound();
      const actor = actorOf(req);
      const b = req.body;
      if (b.status && b.status !== p.status) {
        await setPlatformStatus(db, p.id, b.status, actor);
        // A suspended source's SFTP account is disabled on the SFTP server too.
        if (opts.sftp) await syncSftpAccount(db, opts.sftp.provisioner, p.id);
      }
      if (b.rate_limit_per_min !== undefined || b.allowed_cidrs !== undefined) {
        await updatePlatformAccess(
          db,
          p.id,
          {
            ...(b.allowed_cidrs !== undefined ? { allowedCidrs: b.allowed_cidrs } : {}),
            ...(b.rate_limit_per_min !== undefined
              ? { rateLimitPerMin: b.rate_limit_per_min }
              : {}),
          },
          actor,
        );
      }
      if (b.destination_id !== undefined) {
        if (b.destination_id) {
          const d = await db
            .selectFrom("destinations")
            .select("id")
            .where("id", "=", b.destination_id)
            .executeTakeFirst();
          if (!d) throw problems.validation([{ path: "destination_id", code: "not_found" }]);
        }
        await setPlatformDestination(db, p.id, b.destination_id, actor);
      }
      return { ok: true };
    },
  );

  r.get(
    "/platforms/:code/keys",
    { preHandler: platformsPerm, schema: { params: codeParam } },
    async (req) => {
      const p = await db
        .selectFrom("platforms")
        .select("id")
        .where("code", "=", req.params.code)
        .executeTakeFirst();
      if (!p) throw problems.notFound();
      return { items: await listApiCredentials(db, p.id) };
    },
  );

  r.post(
    "/platforms/:code/keys",
    {
      preHandler: platformsPerm,
      schema: {
        params: codeParam,
        body: z.strictObject({
          label: z.string().trim().max(100).optional(),
          expires_in_days: z.number().int().min(1).max(3_650).optional(),
        }),
      },
    },
    async (req, reply) => {
      const p = await db
        .selectFrom("platforms")
        .select("id")
        .where("code", "=", req.params.code)
        .executeTakeFirst();
      if (!p) throw problems.notFound();
      const issued = await issueApiCredential(
        db,
        {
          platformId: p.id,
          envTag: apiKeyEnvTag(config.APP_ENV),
          label: req.body.label ?? null,
          expiresAt: req.body.expires_in_days
            ? new Date(Date.now() + req.body.expires_in_days * 86_400_000)
            : null,
        },
        actorOf(req),
      );
      reply.header("cache-control", "no-store");
      return reply.code(201).send({
        prefix: issued.prefix,
        token: issued.token,
        expires_at: issued.expiresAt,
        warning: "Shown once. Store it securely and send it to the provider over a secure channel.",
      });
    },
  );

  r.delete(
    "/platforms/:code/keys/:prefix",
    {
      preHandler: platformsPerm,
      schema: { params: codeParam.extend({ prefix: z.string().regex(/^[0-9A-Za-z]{8}$/) }) },
    },
    async (req) => {
      const cred = await db
        .selectFrom("platform_api_credentials as c")
        .innerJoin("platforms as p", "p.id", "c.platform_id")
        .select("c.id")
        .where("p.code", "=", req.params.code)
        .where("c.key_prefix", "=", req.params.prefix)
        .executeTakeFirst();
      if (!cred) throw problems.notFound();
      const ok = await revokeApiCredential(db, req.params.prefix, actorOf(req));
      return { ok, revoked: ok };
    },
  );

  // --- Lead-provider portal logins (managed per provider) ----------------------
  const providerUser = async (code: string, userId?: string) => {
    const p = await db
      .selectFrom("platforms")
      .select(["id", "code", "organisation_id"])
      .where("code", "=", code)
      .executeTakeFirst();
    if (!p) throw problems.notFound();
    if (!userId) return { platform: p, user: undefined };
    const u = await db
      .selectFrom("admin_users")
      .select(["id", "email"])
      .where("id", "=", userId)
      .where("platform_id", "=", p.id)
      .executeTakeFirst();
    if (!u) throw problems.notFound();
    return { platform: p, user: u };
  };
  const auditProvider = (
    req: Parameters<typeof actorOf>[0],
    action: "provider_user.created" | "provider_user.updated" | "provider_user.password_reset",
    targetId: string,
    detail: Record<string, unknown>,
  ) =>
    writeAudit(db, {
      actorType: "admin",
      actorId: req.admin!.id,
      actorLabel: req.admin!.email,
      action,
      targetType: "admin_user",
      targetId,
      requestId: req.id,
      ip: req.ip,
      detail,
    });

  r.get(
    "/platforms/:code/users",
    { preHandler: platformsPerm, schema: { params: codeParam } },
    async (req) => {
      const { platform } = await providerUser(req.params.code);
      const items = await db
        .selectFrom("admin_users")
        .select(["id", "email", "name", "status", "last_login_at", "locked_until", "created_at"])
        .where("platform_id", "=", platform.id)
        .orderBy("email")
        .execute();
      return { items };
    },
  );

  r.post(
    "/platforms/:code/users",
    {
      preHandler: platformsPerm,
      schema: {
        params: codeParam,
        body: z.strictObject({
          email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
          name: z.string().trim().min(1).max(200),
        }),
      },
    },
    async (req, reply) => {
      const { platform } = await providerUser(req.params.code);
      const exists = await db
        .selectFrom("admin_users")
        .select("id")
        .where(sql`lower(email)`, "=", req.body.email)
        .executeTakeFirst();
      if (exists) throw problems.conflict("A user with this email already exists");
      const temp = generatePassword();
      const passwordHash = await hashPassword(temp);
      const u = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("admin_users")
          .values({
            email: req.body.email,
            name: req.body.name,
            auth_provider: "local",
            password_hash: passwordHash,
            password_changed_at: new Date(),
            status: "active",
            organisation_id: platform.organisation_id,
            platform_id: platform.id,
          })
          .returning(["id", "email"])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("admin_user_roles")
          .values({ user_id: created.id, role_code: "provider_viewer" })
          .execute();
        return created;
      });
      await auditProvider(req, "provider_user.created", u.id, {
        email: u.email,
        platform: platform.code,
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send({
        id: u.id,
        email: u.email,
        temporary_password: temp,
        warning: "Shown once. Give it to the provider over a secure channel.",
      });
    },
  );

  r.patch(
    "/platforms/:code/users/:id",
    {
      preHandler: platformsPerm,
      schema: {
        params: codeParam.extend({ id: z.uuid() }),
        body: z.strictObject({
          status: z.enum(["active", "disabled"]).optional(),
          unlock: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const { platform, user } = await providerUser(req.params.code, req.params.id);
      await db.transaction().execute(async (trx) => {
        if (req.body.status) {
          await trx
            .updateTable("admin_users")
            .set({ status: req.body.status })
            .where("id", "=", user!.id)
            .execute();
          if (req.body.status === "disabled")
            await trx.deleteFrom("admin_sessions").where("user_id", "=", user!.id).execute();
        }
        if (req.body.unlock) {
          await trx
            .updateTable("admin_users")
            .set({ locked_until: null, failed_login_count: 0 })
            .where("id", "=", user!.id)
            .execute();
        }
      });
      await auditProvider(req, "provider_user.updated", user!.id, {
        email: user!.email,
        platform: platform.code,
        ...req.body,
      });
      return { ok: true };
    },
  );

  r.post(
    "/platforms/:code/users/:id/reset-password",
    { preHandler: platformsPerm, schema: { params: codeParam.extend({ id: z.uuid() }) } },
    async (req, reply) => {
      const { platform, user } = await providerUser(req.params.code, req.params.id);
      const temp = generatePassword();
      const hashValue = await hashPassword(temp);
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("admin_users")
          .set({
            password_hash: hashValue,
            password_changed_at: new Date(),
            locked_until: null,
            failed_login_count: 0,
          })
          .where("id", "=", user!.id)
          .execute();
        await trx.deleteFrom("admin_sessions").where("user_id", "=", user!.id).execute();
      });
      await auditProvider(req, "provider_user.password_reset", user!.id, {
        email: user!.email,
        platform: platform.code,
      });
      reply.header("cache-control", "no-store");
      return { temporary_password: temp, warning: "Shown once." };
    },
  );

  // --- Agents ------------------------------------------------------------------
  const agentsPerm = requirePermission("agents.manage", { internalOnly: true });
  r.get(
    "/agents",
    {
      preHandler: agentsPerm,
      schema: { querystring: z.object({ platform: z.string().max(16).optional() }) },
    },
    async (req) => {
      let qb = db
        .selectFrom("agents as a")
        .innerJoin("platforms as p", "p.id", "a.platform_id")
        .select([
          "a.id",
          "p.code as platform",
          "a.external_agent_id",
          "a.name",
          "a.email",
          "a.destination_owner_id",
          "a.active",
          "a.first_seen_at",
          "a.last_seen_at",
          sql<number>`(SELECT count(*)::int FROM leads l WHERE l.agent_id = a.id)`.as("lead_count"),
        ]);
      if (req.query.platform) qb = qb.where("p.code", "=", req.query.platform);
      return { items: await qb.orderBy("p.code").orderBy("a.external_agent_id").execute() };
    },
  );

  r.patch(
    "/agents/:id",
    {
      preHandler: agentsPerm,
      schema: {
        params: idParam,
        body: z.strictObject({
          destination_owner_id: z
            .string()
            .trim()
            .max(64)
            .regex(/^[0-9A-Za-z_-]*$/)
            .nullable()
            .optional(),
          active: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const set = {
        ...(req.body.destination_owner_id !== undefined
          ? { destination_owner_id: req.body.destination_owner_id || null }
          : {}),
        ...(req.body.active !== undefined ? { active: req.body.active } : {}),
      };
      if (Object.keys(set).length === 0) return { ok: true };
      const a = await db
        .updateTable("agents")
        .set(set)
        .where("id", "=", req.params.id)
        .returning(["id", "external_agent_id"])
        .executeTakeFirst();
      if (!a) throw problems.notFound();
      await writeAudit(db, {
        actorType: "admin",
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        action: "agent.updated",
        targetType: "agent",
        targetId: a.id,
        requestId: req.id,
        ip: req.ip,
        detail: { external_agent_id: a.external_agent_id, changes: Object.keys(set) },
      });
      return { ok: true };
    },
  );

  // --- Destinations ------------------------------------------------------------
  const destPerm = requirePermission("destinations.manage", { internalOnly: true });
  const hubspotRoutingFields = async () => {
    const r = await hubspotRouting(db, config);
    return { hubspot_enabled: r.enabled, hubspot_sources: r.sources };
  };
  r.get("/destinations", { preHandler: destPerm }, async () => ({
    ...(await hubspotRoutingFields()),
    items: (await listDestinations(db)).map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      is_default: d.is_default,
      status: d.status,
      config: d.config,
      credential_ref: d.credential_ref,
      credential_present: d.type === "mock" ? true : Boolean(process.env[d.credential_ref]),
    })),
  }));

  r.post(
    "/destinations/:id/default",
    { preHandler: destPerm, schema: { params: idParam } },
    async (req) => {
      const d = await db
        .selectFrom("destinations")
        .select(["id", "status"])
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!d) throw problems.notFound();
      if (d.status !== "active") throw problems.conflict("Destination is disabled");
      await setDefaultDestination(db, d.id, actorOf(req));
      return { ok: true };
    },
  );

  r.post(
    "/destinations/:id/test",
    { preHandler: destPerm, schema: { params: idParam } },
    async (req) => {
      const d = await db
        .selectFrom("destinations")
        .selectAll()
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!d) throw problems.notFound();
      let result: { ok: boolean; detail: string };
      try {
        result = await createAdapter(d, { db, config }).healthCheck();
      } catch {
        result = { ok: false, detail: "configuration_invalid" };
      }
      await writeAudit(db, {
        actorType: "admin",
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        action: "destination.tested",
        targetType: "destination",
        targetId: d.id,
        requestId: req.id,
        ip: req.ip,
        detail: { ok: result.ok, detail: result.detail },
      });
      return result;
    },
  );

  // --- Users -------------------------------------------------------------------
  const usersPerm = requirePermission("users.manage", { internalOnly: true });
  const roleCodes = Object.keys(ROLES) as [string, ...string[]];

  r.get("/users", { preHandler: usersPerm }, async () => {
    const users = await db
      .selectFrom("admin_users as u")
      .leftJoin("organisations as o", "o.id", "u.organisation_id")
      .leftJoin("platforms as pl", "pl.id", "u.platform_id")
      .select([
        "pl.code as platform",
        "u.id",
        "u.email",
        "u.name",
        "u.status",
        "u.auth_provider",
        "u.last_login_at",
        "u.locked_until",
        "u.created_at",
        "o.slug as organisation",
        sql<
          string[]
        >`coalesce((SELECT array_agg(role_code ORDER BY role_code) FROM admin_user_roles r WHERE r.user_id = u.id), '{}')`.as(
          "roles",
        ),
      ])
      .orderBy("u.email")
      .execute();
    return {
      items: users,
      roles: Object.entries(ROLES).map(([code, r]) => ({ code, description: r.description })),
    };
  });

  r.post(
    "/users",
    {
      preHandler: usersPerm,
      schema: {
        body: z.strictObject({
          email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
          name: z.string().trim().min(1).max(200),
          roles: z.array(z.enum(roleCodes)).min(1),
          organisation: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const exists = await db
        .selectFrom("admin_users")
        .select("id")
        .where(sql`lower(email)`, "=", req.body.email)
        .executeTakeFirst();
      if (exists) throw problems.conflict("A user with this email already exists");
      if (req.body.roles.includes("provider_viewer")) {
        throw problems.conflict(
          "Create lead-provider logins from the provider's page (Lead providers → Logins)",
        );
      }
      let organisationId: string | null = null;
      if (req.body.organisation) {
        const o = await db
          .selectFrom("organisations")
          .select("id")
          .where("slug", "=", req.body.organisation)
          .executeTakeFirst();
        if (!o) throw problems.validation([{ path: "organisation", code: "not_found" }]);
        organisationId = o.id;
      }
      const tempPassword = generatePassword();
      const passwordHash = await hashPassword(tempPassword);
      const user = await db.transaction().execute(async (trx) => {
        const u = await trx
          .insertInto("admin_users")
          .values({
            email: req.body.email,
            name: req.body.name,
            auth_provider: "local",
            password_hash: passwordHash,
            password_changed_at: new Date(),
            status: "active",
            organisation_id: organisationId,
          })
          .returning(["id", "email"])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("admin_user_roles")
          .values(req.body.roles.map((role_code) => ({ user_id: u.id, role_code })))
          .execute();
        await writeAudit(trx, {
          actorType: "admin",
          actorId: req.admin!.id,
          actorLabel: req.admin!.email,
          action: "user.created",
          targetType: "admin_user",
          targetId: u.id,
          requestId: req.id,
          ip: req.ip,
          detail: {
            email: u.email,
            roles: req.body.roles,
            organisation: req.body.organisation ?? null,
          },
        });
        return u;
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send({
        id: user.id,
        email: user.email,
        temporary_password: tempPassword,
        warning: "Shown once. Give it to the user over a secure channel.",
      });
    },
  );

  r.patch(
    "/users/:id",
    {
      preHandler: usersPerm,
      schema: {
        params: idParam,
        body: z.strictObject({
          status: z.enum(["active", "disabled"]).optional(),
          roles: z.array(z.enum(roleCodes)).min(1).optional(),
          unlock: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const self = req.params.id === req.admin!.id;
      if (
        self &&
        (req.body.status === "disabled" ||
          (req.body.roles &&
            !req.body.roles.includes("super_admin") &&
            req.admin!.roles.includes("super_admin")))
      ) {
        throw problems.conflict("You cannot disable yourself or remove your own super_admin role");
      }
      const u = await db
        .selectFrom("admin_users")
        .select(["id", "email", "platform_id"])
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!u) throw problems.notFound();
      if (req.body.roles) {
        // Provider logins keep exactly the provider role; internal staff can never get it.
        const wantsProvider = req.body.roles.includes("provider_viewer");
        if (u.platform_id ? req.body.roles.join() !== "provider_viewer" : wantsProvider) {
          throw problems.conflict(
            "Lead-provider logins can only have the provider_viewer role, and staff cannot be given it",
          );
        }
      }
      await db.transaction().execute(async (trx) => {
        if (req.body.status) {
          await trx
            .updateTable("admin_users")
            .set({ status: req.body.status })
            .where("id", "=", u.id)
            .execute();
          if (req.body.status === "disabled")
            await trx.deleteFrom("admin_sessions").where("user_id", "=", u.id).execute();
        }
        if (req.body.unlock) {
          await trx
            .updateTable("admin_users")
            .set({ locked_until: null, failed_login_count: 0 })
            .where("id", "=", u.id)
            .execute();
        }
        if (req.body.roles) {
          await trx.deleteFrom("admin_user_roles").where("user_id", "=", u.id).execute();
          await trx
            .insertInto("admin_user_roles")
            .values(req.body.roles.map((role_code) => ({ user_id: u.id, role_code })))
            .execute();
          await trx
            .deleteFrom("admin_sessions")
            .where("user_id", "=", u.id)
            .where("id_hash", "!=", req.admin!.sessionHash)
            .execute();
        }
        await writeAudit(trx, {
          actorType: "admin",
          actorId: req.admin!.id,
          actorLabel: req.admin!.email,
          action: "user.updated",
          targetType: "admin_user",
          targetId: u.id,
          requestId: req.id,
          ip: req.ip,
          detail: { email: u.email, ...req.body },
        });
      });
      return { ok: true };
    },
  );

  r.post(
    "/users/:id/reset-password",
    { preHandler: usersPerm, schema: { params: idParam } },
    async (req, reply) => {
      const u = await db
        .selectFrom("admin_users")
        .select(["id", "email", "auth_provider"])
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!u) throw problems.notFound();
      if (u.auth_provider !== "local") throw problems.conflict("User signs in with SSO");
      const temp = generatePassword();
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("admin_users")
          .set({
            password_hash: await hashPassword(temp),
            password_changed_at: new Date(),
            locked_until: null,
            failed_login_count: 0,
          })
          .where("id", "=", u.id)
          .execute();
        await trx.deleteFrom("admin_sessions").where("user_id", "=", u.id).execute();
        await writeAudit(trx, {
          actorType: "admin",
          actorId: req.admin!.id,
          actorLabel: req.admin!.email,
          action: "user.password_reset",
          targetType: "admin_user",
          targetId: u.id,
          requestId: req.id,
          ip: req.ip,
          detail: { email: u.email },
        });
      });
      reply.header("cache-control", "no-store");
      return { temporary_password: temp, warning: "Shown once." };
    },
  );

  // --- Audit log ---------------------------------------------------------------
  r.get(
    "/audit",
    {
      preHandler: requirePermission("audit.read", { internalOnly: true }),
      schema: {
        querystring: z.object({
          action: z.string().max(64).optional(),
          actor: z.string().max(254).optional(),
          target: z.string().max(100).optional(),
          from: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          to: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      let qb = db.selectFrom("audit_log");
      if (q.action)
        qb = qb.where("action", "like", `${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      if (q.actor) qb = qb.where("actor_label", "=", q.actor);
      if (q.target) qb = qb.where("target_id", "=", q.target);
      if (q.from) qb = qb.where("occurred_at", ">=", dayStart(q.from, config.REPORT_TIMEZONE));
      if (q.to) qb = qb.where("occurred_at", "<", dayEnd(q.to, config.REPORT_TIMEZONE));
      const [{ total }] = (await qb.select(sql<number>`count(*)::int`.as("total")).execute()) as [
        { total: number },
      ];
      const items = await qb
        .select([
          "id",
          "occurred_at",
          "actor_type",
          "actor_label",
          "action",
          "target_type",
          "target_id",
          "request_id",
          "ip",
          "detail",
        ])
        .orderBy("id", "desc")
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute();
      return { items, total, page: q.page, pageSize: q.pageSize };
    },
  );
}
