/**
 * Application-level encryption helpers (foundation for PII and stored secrets).
 *
 * - encrypt/decrypt: AES-256-GCM, random 12-byte IV, output = version(1) | iv(12) | tag(16) | ciphertext
 * - blindIndex: HMAC-SHA256 of a normalised value, allowing exact-match search on encrypted columns
 *
 * Whether lead email/phone are stored encrypted is open question Q18 in the architecture proposal;
 * these helpers are needed either way for HMAC secrets and MFA secrets.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function toKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  return key;
}

export function encrypt(plaintext: string, base64Key: string): Buffer {
  return encryptBytes(Buffer.from(plaintext, "utf8"), base64Key);
}

/** Same format as encrypt(), for binary data such as audio files. */
export function encryptBytes(data: Uint8Array, base64Key: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", toKey(base64Key), iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(payload: Uint8Array, base64Key: string): string {
  return decryptBytes(payload, base64Key).toString("utf8");
}

export function decryptBytes(payload: Uint8Array, base64Key: string): Buffer {
  const buf = Buffer.from(payload);
  if (buf.length < 1 + IV_LENGTH + TAG_LENGTH || buf[0] !== VERSION) {
    throw new Error("Unsupported ciphertext");
  }
  const iv = buf.subarray(1, 1 + IV_LENGTH);
  const tag = buf.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", toKey(base64Key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(buf.subarray(1 + IV_LENGTH + TAG_LENGTH)),
    decipher.final(),
  ]);
}

/** Deterministic keyed hash; callers must normalise the value first (e.g. lower-case email, E.164 phone). */
export function blindIndex(normalisedValue: string, base64Key: string): Buffer {
  return createHmac("sha256", toKey(base64Key)).update(normalisedValue, "utf8").digest();
}
