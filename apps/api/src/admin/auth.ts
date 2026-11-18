/**
 * Admin authentication: local accounts (argon2id passwords), opaque server-side sessions,
 * account lockout, permission checks and organisation scoping.
 *
 * SSO (Microsoft Entra / Google) is the intended production option but needs an external identity
 * provider, so it is deferred while development is local-only.
 */

import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Env } from "@lim/config";
import { problems, type Permission } from "@lim/core";
import { writeAudit, type Database } from "@lim/db";

export const SESSION_COOKIE = "lim_admin_session";
export const CSRF_HEADER = "x-lim-admin";

export interface AdminContext {
  id: string;
  email: string;
  name: string | null;
  /** null = internal staff (all organisations) */
  organisationId: string | null;
  /** Set for lead-provider portal users: every query is restricted to this platform. */
  platformId: string | null;
  platformCode: string | null;
  roles: string[];
  permissions: Set<Permission>;
  sessionHash: Buffer;
}

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminContext;
  }
}

type AuthConfig = Pick<
  Env,
  | "ADMIN_SESSION_HOURS"
  | "ADMIN_SESSION_IDLE_MINUTES"
  | "ADMIN_LOCKOUT_THRESHOLD"
  | "ADMIN_LOCKOUT_MINUTES"
  | "ADMIN_COOKIE_SECURE"
>;

export const PASSWORD_RULE = { min: 12, max: 128 };

export function validatePassword(pw: string): string | null {
  if (pw.length < PASSWORD_RULE.min) return `must be at least ${PASSWORD_RULE.min} characters`;
  if (pw.length > PASSWORD_RULE.max) return `must be at most ${PASSWORD_RULE.max} characters`;
  return null;
}

export const hashPassword = (pw: string) => hash(pw); // argon2id, library defaults (OWASP minimums)

/** Random temporary password: 20 chars from an unambiguous alphabet (~115 bits). */
export function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const sessionHash = (token: string) => createHash("sha256").update(token).digest();

// A real argon2id hash of a random value, verified against when the email is unknown,
// so response time does not reveal whether an account exists.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hash(randomBytes(16).toString("hex")));

export interface LoginResult {
  token: string;
  expiresAt: Date;
}

/** Returns a session token, or null for any failure (unknown, wrong password, locked, disabled). */
export async function login(
  db: Kysely<Database>,
  config: AuthConfig,
  input: {
    email: string;
    password: string;
    ip: string;
    userAgent: string | null;
    requestId: string;
  },
): Promise<LoginResult | null> {
  const email = input.email.trim().toLowerCase();
  const user = await db
    .selectFrom("admin_users")
    .selectAll()
    .where(sql`lower(email)`, "=", email)
    .executeTakeFirst();

  const fail = async (reason: string) => {
    await writeAudit(db, {
      actorType: "admin",
      actorId: user?.id ?? null,
      actorLabel: user ? user.email : "unknown-account",
      organisationId: user?.organisation_id ?? null,
      action: "admin.login_failed",
      targetType: "admin_user",
      targetId: user?.id ?? null,
      requestId: input.requestId,
      ip: input.ip,
      detail: { reason },
    });
    return null;
  };

  if (!user || !user.password_hash || user.auth_provider !== "local") {
    await verify(await getDummyHash(), input.password).catch(() => false);
    return fail("unknown_account");
  }
  if (user.status !== "active") {
    await verify(user.password_hash, input.password).catch(() => false);
    return fail("account_not_active");
  }
  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    return fail("locked");
  }

  const ok = await verify(user.password_hash, input.password).catch(() => false);
  if (!ok) {
    const failures = user.failed_login_count + 1;
    const lock = failures >= config.ADMIN_LOCKOUT_THRESHOLD;
    await db
      .updateTable("admin_users")
      .set({
        failed_login_count: lock ? 0 : failures,
        locked_until: lock ? new Date(Date.now() + config.ADMIN_LOCKOUT_MINUTES * 60_000) : null,
      })
      .where("id", "=", user.id)
      .execute();
    return fail(lock ? "wrong_password_locked" : "wrong_password");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.ADMIN_SESSION_HOURS * 3_600_000);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("admin_users")
      .set({ failed_login_count: 0, locked_until: null, last_login_at: sql`now()` })
      .where("id", "=", user.id)
      .execute();
    await trx
      .insertInto("admin_sessions")
      .values({
        id_hash: sessionHash(token),
        user_id: user.id,
        expires_at: expiresAt,
        ip: input.ip,
        user_agent: input.userAgent?.slice(0, 300) ?? null,
      })
      .execute();
    // Opportunistic clean-up of expired sessions.
    await trx
      .deleteFrom("admin_sessions")
      .where("expires_at", "<", sql<Date>`now()`)
      .execute();
    await writeAudit(trx, {
      actorType: "admin",
      actorId: user.id,
      actorLabel: user.email,
      organisationId: user.organisation_id,
      action: "admin.login",
      targetType: "admin_user",
      targetId: user.id,
      requestId: input.requestId,
      ip: input.ip,
    });
  });
  return { token, expiresAt };
}

export async function logout(db: Kysely<Database>, admin: AdminContext, req: FastifyRequest) {
  await db.deleteFrom("admin_sessions").where("id_hash", "=", admin.sessionHash).execute();
  await writeAudit(db, {
    actorType: "admin",
    actorId: admin.id,
    actorLabel: admin.email,
    organisationId: admin.organisationId,
    action: "admin.logout",
    requestId: req.id,
    ip: req.ip,
  });
}

/** Changes the signed-in user's password; ends their other sessions. Returns false if `current` is wrong. */
export async function changePassword(
  db: Kysely<Database>,
  admin: AdminContext,
  current: string,
  next: string,
  req: FastifyRequest,
): Promise<boolean> {
  const user = await db
    .selectFrom("admin_users")
    .select(["password_hash"])
    .where("id", "=", admin.id)
    .executeTakeFirst();
  if (!user?.password_hash || !(await verify(user.password_hash, current).catch(() => false)))
    return false;
  const newHash = await hashPassword(next);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("admin_users")
      .set({ password_hash: newHash, password_changed_at: sql`now()` })
      .where("id", "=", admin.id)
      .execute();
    await trx
      .deleteFrom("admin_sessions")
      .where("user_id", "=", admin.id)
      .where("id_hash", "!=", admin.sessionHash)
      .execute();
    await writeAudit(trx, {
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "user.password_changed",
      targetType: "admin_user",
      targetId: admin.id,
      requestId: req.id,
      ip: req.ip,
    });
  });
  return true;
}

export function setSessionCookie(
  reply: FastifyReply,
  config: AuthConfig,
  token: string,
  expiresAt: Date,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.ADMIN_COOKIE_SECURE,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AuthConfig) {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.ADMIN_COOKIE_SECURE,
    sameSite: "strict",
    path: "/",
  });
}

/** onRequest hook: loads the admin from the session cookie or rejects with 401. */
export function createSessionAuthenticator(db: Kysely<Database>, config: AuthConfig) {
  return async function authenticateAdmin(request: FastifyRequest): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    if (!token || token.length > 100) throw problems.unauthorized();
    const idHash = sessionHash(token);

    const row = await db
      .selectFrom("admin_sessions as s")
      .innerJoin("admin_users as u", "u.id", "s.user_id")
      .select([
        "u.id",
        "u.email",
        "u.name",
        "u.organisation_id",
        "u.platform_id",
        "u.status",
        "s.expires_at",
        "s.last_seen_at",
      ])
      .where("s.id_hash", "=", idHash)
      .executeTakeFirst();

    const idleCutoff = Date.now() - config.ADMIN_SESSION_IDLE_MINUTES * 60_000;
    if (
      !row ||
      row.status !== "active" ||
      row.expires_at.getTime() <= Date.now() ||
      row.last_seen_at.getTime() < idleCutoff
    ) {
      if (row) await db.deleteFrom("admin_sessions").where("id_hash", "=", idHash).execute();
      throw problems.unauthorized();
    }

    if (Date.now() - row.last_seen_at.getTime() > 60_000) {
      await db
        .updateTable("admin_sessions")
        .set({ last_seen_at: sql`now()` })
        .where("id_hash", "=", idHash)
        .execute();
    }

    const perms = await db
      .selectFrom("admin_user_roles as ur")
      .innerJoin("role_permissions as rp", "rp.role_code", "ur.role_code")
      .select(["ur.role_code", "rp.permission"])
      .where("ur.user_id", "=", row.id)
      .execute();

    request.admin = {
      id: row.id,
      email: row.email,
      name: row.name,
      organisationId: row.organisation_id,
      platformId: row.platform_id,
      platformCode: row.platform_id
        ? ((
            await db
              .selectFrom("platforms")
              .select("code")
              .where("id", "=", row.platform_id)
              .executeTakeFirst()
          )?.code ?? null)
        : null,
      roles: [...new Set(perms.map((p) => p.role_code))],
      permissions: new Set(perms.map((p) => p.permission as Permission)),
      sessionHash: idHash,
    };
  };
}

/** preHandler factory: requires a permission (and optionally internal staff). */
export function requirePermission(permission: Permission, opts: { internalOnly?: boolean } = {}) {
  return async (request: FastifyRequest) => {
    const admin = request.admin;
    if (!admin) throw problems.unauthorized();
    if (!admin.permissions.has(permission)) throw problems.forbidden("Missing permission");
    if (opts.internalOnly && admin.organisationId !== null)
      throw problems.forbidden("Internal staff only");
  };
}

export const actorOf = (req: FastifyRequest) => ({
  type: "admin" as const,
  id: req.admin!.id,
  label: req.admin!.email,
  requestId: req.id,
  ip: req.ip,
});
