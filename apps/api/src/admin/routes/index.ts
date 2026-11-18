/**
 * Admin API (/admin/v1), used only by the admin dashboard.
 *
 * Security:
 *  - session cookie (HttpOnly, SameSite=Strict); every route except login requires a valid session
 *  - every state-changing request must carry the X-Lim-Admin: 1 header (CSRF guard: browsers cannot
 *    send custom headers cross-site without a CORS preflight, and no CORS is enabled)
 *  - permissions checked per route; organisation scoping applied in queries
 */

import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Env } from "@lim/config";
import { problems } from "@lim/core";
import type { Database } from "@lim/db";
import type { PgBoss } from "@lim/jobs";
import {
  clearSessionCookie,
  createSessionAuthenticator,
  changePassword,
  CSRF_HEADER,
  login,
  logout,
  setSessionCookie,
  validatePassword,
} from "../auth.js";
import { adminLeadRoutes } from "./leads.js";
import { sftpRuntime, type SftpRuntime } from "@lim/recordings";
import { adminManageRoutes } from "./manage.js";
import { adminReportRoutes } from "./reports.js";
import { adminRecordingRoutes } from "./recordings.js";
import { adminSystemRoutes } from "./system.js";
import { adminOverviewRoutes } from "./overview.js";

export interface AdminRouteOptions {
  db: Kysely<Database>;
  config: Env;
  boss: PgBoss;
  sftp?: SftpRuntime;
}

declare module "fastify" {
  interface FastifyContextConfig {
    publicAdminRoute?: boolean;
  }
}

export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions) {
  const { db, config } = opts;
  await app.register(cookie);

  const adminLimit = app.createRateLimit({
    max: config.ADMIN_RATE_PER_MIN,
    timeWindow: 60_000,
    keyGenerator: (req) => `admin:${req.ip}`,
  });
  app.addHook("onRequest", async (request) => {
    const r = await adminLimit(request);
    if (!r.isAllowed && r.isExceeded) throw problems.rateLimited(r.ttlInSeconds);
  });

  app.addHook("onRequest", async (request) => {
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers[CSRF_HEADER] !== "1"
    ) {
      throw problems.forbidden("Missing admin request header");
    }
  });

  const authenticate = createSessionAuthenticator(db, config);
  app.addHook("onRequest", async (request) => {
    if (request.routeOptions.config?.publicAdminRoute) return;
    await authenticate(request);
  });

  const loginLimit = app.createRateLimit({
    max: config.ADMIN_LOGIN_RATE_PER_MIN,
    timeWindow: 60_000,
    keyGenerator: (req) => `admin-login:${req.ip}`,
  });
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/auth/login",
    {
      config: { publicAdminRoute: true },
      schema: {
        body: z.strictObject({ email: z.string().max(254), password: z.string().min(1).max(256) }),
      },
    },
    async (req, reply) => {
      const limit = await loginLimit(req);
      if (!limit.isAllowed && limit.isExceeded) throw problems.rateLimited(limit.ttlInSeconds);
      const result = await login(db, config, {
        email: req.body.email,
        password: req.body.password,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: req.id,
      });
      if (!result) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://lead-integration-middleware/problems/unauthorized",
          title: "Invalid email or password, or the account is temporarily locked",
          status: 401,
          request_id: req.id,
        });
      }
      setSessionCookie(reply, config, result.token, result.expiresAt);
      return { ok: true };
    },
  );

  r.get("/auth/me", async (req) => {
    const a = req.admin!;
    return {
      id: a.id,
      email: a.email,
      name: a.name,
      organisation_id: a.organisationId,
      platform: a.platformCode,
      roles: a.roles,
      permissions: [...a.permissions].sort(),
      environment: config.APP_ENV,
      hubspot_enabled: config.HUBSPOT_ENABLED,
    };
  });

  r.post(
    "/auth/change-password",
    {
      schema: {
        body: z.strictObject({
          current_password: z.string().min(1).max(256),
          new_password: z.string().max(256),
        }),
      },
    },
    async (req, reply) => {
      const problem = validatePassword(req.body.new_password);
      if (problem) throw problems.validation([{ path: "new_password", code: "too_weak" }]);
      if (req.body.new_password === req.body.current_password) {
        throw problems.validation([{ path: "new_password", code: "same_as_current" }]);
      }
      const ok = await changePassword(
        db,
        req.admin!,
        req.body.current_password,
        req.body.new_password,
        req,
      );
      if (!ok) throw problems.validation([{ path: "current_password", code: "incorrect" }]);
      return reply.send({ ok: true });
    },
  );

  r.post("/auth/logout", async (req, reply) => {
    await logout(db, req.admin!, req);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  // Pass only the dependencies: forwarding `opts` would re-apply the parent's prefix.
  const deps: AdminRouteOptions = {
    db,
    config,
    boss: opts.boss,
    sftp: opts.sftp ?? sftpRuntime(config),
  };
  await app.register(adminLeadRoutes, deps);
  await app.register(adminManageRoutes, deps);
  await app.register(adminReportRoutes, deps);
  await app.register(adminRecordingRoutes, deps);
  await app.register(adminSystemRoutes, deps);
  await app.register(adminOverviewRoutes, deps);
}
