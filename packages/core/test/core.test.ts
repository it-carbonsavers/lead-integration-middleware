import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptRequestId,
  bearerToken,
  blindIndex,
  decrypt,
  encrypt,
  generateApiKey,
  isIpAllowed,
  newLeadRef,
  parseApiKey,
  verifyApiKeySecret,
} from "../src/index.js";

describe("API keys", () => {
  it("generates a well-formed key whose secret verifies against the stored hash only", () => {
    const k = generateApiKey("test");
    expect(k.token).toMatch(/^lim_test_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}$/);
    const parsed = parseApiKey(k.token)!;
    expect(parsed.prefix).toBe(k.prefix);
    expect(verifyApiKeySecret(parsed.secret, k.hash)).toBe(true);
    expect(verifyApiKeySecret(parsed.secret.replace(/.$/, "x"), k.hash)).toBe(false);
    expect(k.hash.length).toBe(32);
    // The stored hash never contains the secret.
    expect(k.hash.toString("utf8")).not.toContain(parsed.secret);
  });

  it("generates unique keys", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateApiKey("dev").token));
    expect(seen.size).toBe(200);
  });

  it("rejects malformed keys", () => {
    for (const bad of [
      "",
      "lim_test_abc_def",
      "lim_prod_AAAAAAAA_" + "a".repeat(43),
      "Bearer x",
      "lim_test_AAAAAAA-_" + "a".repeat(43),
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it("returns false (not throws) when the stored hash has the wrong length", () => {
    expect(verifyApiKeySecret("x", Buffer.alloc(5))).toBe(false);
  });

  it("extracts bearer tokens", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("encryption helpers", () => {
  const key = randomBytes(32).toString("base64");

  it("round-trips and uses a random IV", () => {
    const a = encrypt("alex@example.com", key);
    const b = encrypt("alex@example.com", key);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, key)).toBe("alex@example.com");
  });

  it("detects tampering and wrong keys", () => {
    const c = encrypt("secret", key);
    c[c.length - 1] = c[c.length - 1]! ^ 0xff;
    expect(() => decrypt(c, key)).toThrow();
    expect(() => decrypt(encrypt("secret", key), randomBytes(32).toString("base64"))).toThrow();
  });

  it("produces deterministic blind indexes per key", () => {
    expect(blindIndex("+61412345678", key).equals(blindIndex("+61412345678", key))).toBe(true);
    expect(blindIndex("+61412345678", key).equals(blindIndex("+61412345679", key))).toBe(false);
  });
});

describe("IP allow-list", () => {
  it("allows everything when the list is empty", () => {
    expect(isIpAllowed("198.51.100.7", [])).toBe(true);
  });
  it("matches IPv4, IPv4-mapped IPv6 and IPv6 ranges", () => {
    const list = ["203.0.113.0/24", "2001:db8::/32", "198.51.100.10"];
    expect(isIpAllowed("203.0.113.55", list)).toBe(true);
    expect(isIpAllowed("::ffff:203.0.113.55", list)).toBe(true);
    expect(isIpAllowed("198.51.100.10", list)).toBe(true);
    expect(isIpAllowed("2001:db8:1::5", list)).toBe(true);
    expect(isIpAllowed("198.51.100.11", list)).toBe(false);
    expect(isIpAllowed("not-an-ip", list)).toBe(false);
  });
});

describe("ids", () => {
  it("creates lead refs and accepts only safe inbound request ids", () => {
    expect(newLeadRef()).toMatch(/^LD-[0-9A-Z]{26}$/);
    expect(acceptRequestId("abc-123_XYZ.9")).toBe("abc-123_XYZ.9");
    expect(acceptRequestId("short")).toBeNull();
    expect(acceptRequestId("bad id with spaces")).toBeNull();
    expect(acceptRequestId("x".repeat(65))).toBeNull();
  });
});
