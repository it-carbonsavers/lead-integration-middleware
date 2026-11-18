/**
 * Rate limiting for the provider API.
 *
 *  1. Per client IP, before authentication: caps brute-force and noise from unauthenticated callers.
 *  2. Per platform, after authentication: each platform has its own ceiling (default from config,
 *     overridable per platform in the database).
 *
 * Counters are kept in process memory, which is correct while the API runs as one instance.
 * If the API is scaled horizontally, switch the store to Redis (the plugin supports it).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import type { Env } from "@lim/config";
import { problems } from "@lim/core";

export interface RateLimiters {
  limitByIp: (request: FastifyRequest) => Promise<void>;
  limitByPlatform: (request: FastifyRequest) => Promise<void>;
}

export async function registerRateLimiters(
  app: FastifyInstance,
  config: Pick<Env, "RATE_LIMIT_IP_PER_MIN" | "RATE_LIMIT_PLATFORM_DEFAULT_PER_MIN">,
): Promise<RateLimiters> {
  await app.register(fastifyRateLimit, { global: false });

  const ipCheck = app.createRateLimit({
    max: config.RATE_LIMIT_IP_PER_MIN,
    timeWindow: 60_000,
    keyGenerator: (req) => `ip:${req.ip}`,
  });
  const platformCheck = app.createRateLimit({
    max: (req) => req.platform?.rateLimitPerMin ?? config.RATE_LIMIT_PLATFORM_DEFAULT_PER_MIN,
    timeWindow: 60_000,
    keyGenerator: (req) => `platform:${req.platform?.id ?? "unknown"}`,
  });

  return {
    async limitByIp(request) {
      // isAllowed=true only means "on the allow-list"; the limit decision is isExceeded.
      const r = await ipCheck(request);
      if (!r.isAllowed && r.isExceeded) throw problems.rateLimited(r.ttlInSeconds);
    },
    async limitByPlatform(request) {
      const r = await platformCheck(request);
      if (!r.isAllowed && r.isExceeded) {
        request.log.warn({ platform: request.platform?.code }, "platform rate limit exceeded");
        throw problems.rateLimited(r.ttlInSeconds);
      }
    },
  };
}
