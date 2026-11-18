/**
 * Provider API keys.
 *
 * Format:  lim_<env>_<prefix>_<secret>
 *   env     live | stg | dev | test  (a key only works in the environment that issued it)
 *   prefix  8 base62 chars, stored in clear, used to look the credential up
 *   secret  43 base62 chars (~256 bits), never stored; only SHA-256(secret) is kept
 *
 * Because the secret is long and random, a fast hash (SHA-256) is appropriate; slow password
 * hashes (argon2/bcrypt) are for low-entropy human passwords. Verification compares two
 * fixed-length 32-byte digests in constant time, so neither content nor length leaks.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export type ApiKeyEnvTag = "live" | "stg" | "dev" | "test";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const API_KEY_PREFIX_LENGTH = 8;
export const API_KEY_SECRET_LENGTH = 43;
const KEY_PATTERN = /^lim_(live|stg|dev|test)_([0-9A-Za-z]{8})_([0-9A-Za-z]{43})$/;

function randomBase62(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[randomInt(BASE62.length)];
  return out;
}

export interface GeneratedApiKey {
  /** Full token to hand to the provider once. Never store or log it. */
  token: string;
  prefix: string;
  /** SHA-256 of the secret part: the only thing persisted. */
  hash: Buffer;
}

export function generateApiKey(env: ApiKeyEnvTag): GeneratedApiKey {
  const prefix = randomBase62(API_KEY_PREFIX_LENGTH);
  const secret = randomBase62(API_KEY_SECRET_LENGTH);
  return { token: `lim_${env}_${prefix}_${secret}`, prefix, hash: hashApiKeySecret(secret) };
}

export interface ParsedApiKey {
  env: ApiKeyEnvTag;
  prefix: string;
  secret: string;
}

/** Returns null for anything that is not a well-formed key (no detail on why). */
export function parseApiKey(token: string): ParsedApiKey | null {
  const m = KEY_PATTERN.exec(token);
  if (!m) return null;
  return { env: m[1] as ApiKeyEnvTag, prefix: m[2]!, secret: m[3]! };
}

export function hashApiKeySecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Constant-time comparison of SHA-256(secret) with the stored digest. */
export function verifyApiKeySecret(secret: string, storedHash: Uint8Array): boolean {
  const candidate = hashApiKeySecret(secret);
  if (storedHash.length !== candidate.length) return false;
  return timingSafeEqual(candidate, storedHash);
}

/** Extracts the token from an `Authorization: Bearer <token>` header value. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}
