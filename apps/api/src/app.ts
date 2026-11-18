/**
 * Builds the Fastify application. Kept separate from server.ts so tests can create an app
 * against a test database without opening a port.
 */

import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { loggerOptions, type Env } from "@lim/config";
import { acceptRequestId, newRequestId } from "@lim/core";
import type { Database } from "@lim/db";
import type { PgBoss } from "@lim/jobs";
import { registerErrorHandling } from "./plugins/errors.js";
import { registerRateLimiters } from "./plugins/rate-limits.js";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1/index.js";
import { buildOpenApiDocument } from "./openapi.js";
import type { SftpRuntime } from "@lim/recordings";
import { adminRoutes } from "./admin/routes/index.js";

export interface BuildAppOptions {
  config: Env;
  db: Kysely<Database>;
  /** Producer-side job queue (started by the caller). */
  boss: PgBoss;
  /** Override the logger (tests pass false to silence output). */
  logger?: boolean;
  /** SFTP server components (tests inject fakes); default built from config. */
  sftp?: SftpRuntime;
}

export async function buildApp({
  config,
  db,
  boss,
  logger,
  sftp,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger === false ? false : loggerOptions(config, "lim-api"),
    // Trust exactly N proxy hops (Railway edge = 1) so a client cannot spoof its IP via X-Forwarded-For.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: config.BODY_LIMIT_BYTES,
    requestIdHeader: false,
    genReqId: (req) => acceptRequestId(req.headers["x-request-id"]) ?? newRequestId(),
    return503OnClosing: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // JSON only. Fastify accepts text/plain by default; providers must send application/json.
  app.removeContentTypeParser("text/plain");

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", "no-store");
  });

  // API-only service: strict defaults, no CSP needed for JSON, no CORS (server-to-server).
  await app.register(helmet, { contentSecurityPolicy: false, global: true });

  registerErrorHandling(app);
  const limiters = await registerRateLimiters(app, config);

  await app.register(healthRoutes, { db });
  const openApi = buildOpenApiDocument();
  app.get("/openapi.json", async () => openApi);
  await app.register(v1Routes, { prefix: "/v1", db, config, boss, limiters });
  await app.register(adminRoutes, {
    prefix: "/admin/v1",
    db,
    config,
    boss,
    ...(sftp ? { sftp } : {}),
  });

  return app;
}
