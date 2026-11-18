/**
 * Provider (source platform) authentication for /v1 routes.
 *
 *   Authorization: Bearer lim_<env>_<prefix>_<secret>
 *
 * The platform identity comes ONLY from the credential, never from the request body,
 * so one provider can never act as another. All authentication failures return the same
 * 401 body (no hint whether the key exists, is revoked or expired); the specific reason is
 * logged server-side with the key prefix only.
 */

import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { apiKeyEnvTag, type Env } from "@lim/config";
import { bearerToken, isIpAllowed, parseApiKey, problems, verifyApiKeySecret } from "@lim/core";
import { findCredentialForAuth, touchCredential, type Database } from "@lim/db";

export interface AuthenticatedPlatform {
  id: string;
  code: string;
  organisationId: string;
  credentialId: string;
  rateLimitPerMin: number;
}

declare module "fastify" {
  interface FastifyRequest {
    platform?: AuthenticatedPlatform;
  }
}

type AuthConfig = Pick<
  Env,
  "APP_ENV" | "RATE_LIMIT_PLATFORM_DEFAULT_PER_MIN" | "API_KEY_LAST_USED_THROTTLE_SECONDS"
>;

export function createPlatformAuthenticator(db: Kysely<Database>, config: AuthConfig) {
  const expectedEnv = apiKeyEnvTag(config.APP_ENV);

  return async function authenticatePlatform(request: FastifyRequest): Promise<void> {
    const deny = (reason: string, prefix?: string) => {
      request.log.warn({ reason, keyPrefix: prefix }, "platform authentication failed");
      return problems.unauthorized();
    };

    const token = bearerToken(request.headers.authorization);
    if (!token) throw deny("missing_bearer");

    const parsed = parseApiKey(token);
    if (!parsed) throw deny("malformed_key");
    if (parsed.env !== expectedEnv) throw deny("wrong_environment", parsed.prefix);

    const cred = await findCredentialForAuth(db, parsed.prefix);
    // Hash even when the prefix is unknown, so response time does not reveal which prefixes exist.
    const valid = verifyApiKeySecret(parsed.secret, cred?.key_hash ?? Buffer.alloc(32));
    if (!cred || !valid) throw deny("unknown_or_wrong_key", parsed.prefix);
    if (cred.env_tag !== expectedEnv) throw deny("wrong_environment", parsed.prefix);
    if (cred.revoked_at) throw deny("revoked", parsed.prefix);
    if (cred.expires_at && cred.expires_at.getTime() <= Date.now())
      throw deny("expired", parsed.prefix);

    if (cred.platform_status !== "active" || cred.organisation_status !== "active") {
      request.log.warn(
        { keyPrefix: parsed.prefix, platform: cred.platform_code },
        "platform suspended",
      );
      throw problems.forbidden("Platform is suspended");
    }
    if (!isIpAllowed(request.ip, cred.allowed_cidrs)) {
      request.log.warn(
        { keyPrefix: parsed.prefix, platform: cred.platform_code, ip: request.ip },
        "source IP not allowed",
      );
      throw problems.forbidden("Source IP address is not allowed");
    }

    request.platform = {
      id: cred.platform_id,
      code: cred.platform_code,
      organisationId: cred.organisation_id,
      credentialId: cred.credential_id,
      rateLimitPerMin: cred.rate_limit_per_min ?? config.RATE_LIMIT_PLATFORM_DEFAULT_PER_MIN,
    };

    try {
      await touchCredential(db, cred.credential_id, config.API_KEY_LAST_USED_THROTTLE_SECONDS);
    } catch (err) {
      request.log.warn({ err }, "could not update credential last_used_at");
    }
  };
}
