/**
 * Provider API, version 1.  Every route in this scope is:
 *   1. rate limited per client IP (before auth)
 *   2. authenticated by platform API key
 *   3. rate limited per platform
 * Routes: GET /ping, POST /leads, GET /leads/:lead_ref, GET /leads?external_lead_id=
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Env } from "@lim/config";
import type { Database } from "@lim/db";
import type { PgBoss } from "@lim/jobs";
import { leadRoutes } from "./leads.js";
import { createPlatformAuthenticator } from "../../plugins/platform-auth.js";
import type { RateLimiters } from "../../plugins/rate-limits.js";

export interface V1Options {
  db: Kysely<Database>;
  config: Env;
  boss: PgBoss;
  limiters: RateLimiters;
}

const pingResponse = z.object({
  authenticated: z.literal(true),
  platform: z.string(),
  environment: z.string(),
  server_time: z.string(),
});

export async function v1Routes(app: FastifyInstance, opts: V1Options): Promise<void> {
  const authenticate = createPlatformAuthenticator(opts.db, opts.config);

  app.addHook("onRequest", opts.limiters.limitByIp);
  app.addHook("onRequest", authenticate);
  app.addHook("preHandler", opts.limiters.limitByPlatform);

  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Lets a provider verify connectivity and credentials during onboarding. Returns no lead data. */
  r.get("/ping", { schema: { response: { 200: pingResponse } } }, async (request) => ({
    authenticated: true as const,
    platform: request.platform!.code,
    environment: opts.config.APP_ENV,
    server_time: new Date().toISOString(),
  }));

  await app.register(leadRoutes, { db: opts.db, boss: opts.boss, config: opts.config });
}
