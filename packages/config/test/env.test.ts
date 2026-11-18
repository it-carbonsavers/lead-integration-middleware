import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiKeyEnvTag, ConfigError, loadConfig } from "../src/index.js";

const key = () => randomBytes(32).toString("base64");
const dbOnly = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };
const base = { ...dbOnly, APP_ENCRYPTION_KEY: key(), APP_BLIND_INDEX_KEY: key() };

describe("loadConfig", () => {
  it("applies safe defaults for local development", () => {
    const c = loadConfig(base);
    expect(c.APP_ENV).toBe("local");
    expect(c.PORT).toBe(3000);
    expect(c.TRUST_PROXY_HOPS).toBe(0);
    expect(c.RATE_LIMIT_PLATFORM_DEFAULT_PER_MIN).toBe(60);
    expect(c.DEFAULT_PHONE_REGION).toBe("AU");
    expect(c.DUPLICATE_WINDOW_DAYS).toBe(30);
  });

  it("fails without DATABASE_URL and names the variable, not values", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ DATABASE_URL: "mysql://secret-host" });
    } catch (e) {
      expect((e as ConfigError).message).toContain("DATABASE_URL");
      expect((e as ConfigError).message).not.toContain("secret-host");
    }
  });

  it("requires encryption keys in every environment", () => {
    expect(() => loadConfig(dbOnly)).toThrow(/APP_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...dbOnly, APP_ENCRYPTION_KEY: key() })).toThrow(
      /APP_BLIND_INDEX_KEY/,
    );
    expect(loadConfig({ ...base, APP_ENV: "staging" }).APP_ENV).toBe("staging");
  });

  it("validates the default phone region", () => {
    expect(() => loadConfig({ ...base, DEFAULT_PHONE_REGION: "au" })).toThrow(
      /DEFAULT_PHONE_REGION/,
    );
  });

  it("rejects keys that are not 32 bytes and identical encryption/index keys", () => {
    expect(() => loadConfig({ ...base, APP_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
    const k = key();
    expect(() => loadConfig({ ...dbOnly, APP_ENCRYPTION_KEY: k, APP_BLIND_INDEX_KEY: k })).toThrow(
      /must differ/,
    );
  });

  it("refuses unencrypted database connections in production", () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: "production",
        APP_ENCRYPTION_KEY: key(),
        APP_BLIND_INDEX_KEY: key(),
      }),
    ).toThrow(/DATABASE_SSL/);
    // Railway private network host is allowed without TLS.
    expect(
      loadConfig({
        DATABASE_URL: "postgres://u:p@postgres.railway.internal:5432/railway",
        APP_ENV: "production",
        APP_ENCRYPTION_KEY: key(),
        APP_BLIND_INDEX_KEY: key(),
      }).DATABASE_SSL,
    ).toBe("disable");
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ ...base, PORT: "" }).PORT).toBe(3000);
  });

  it("maps environments to API key tags", () => {
    expect(apiKeyEnvTag("production")).toBe("live");
    expect(apiKeyEnvTag("staging")).toBe("stg");
    expect(apiKeyEnvTag("local")).toBe("dev");
    expect(apiKeyEnvTag("test")).toBe("test");
  });
});

describe("remote SFTP server and bucket in local development", () => {
  const sftp = {
    SFTPGO_API_URL: "https://sftpgo-dev.example.com",
    SFTPGO_ADMIN_USER: "admin",
    SFTPGO_ADMIN_PASSWORD: "pw",
    SFTP_PUBLIC_HOST: "sftp.example.com",
    SFTP_PUBLIC_PORT: "41555",
    UPLOADS_BUCKET: "b",
    S3_ENDPOINT: "https://storage.example.com",
    S3_ACCESS_KEY_ID: "k",
    S3_SECRET_ACCESS_KEY: "s",
  };
  it("is refused locally unless explicitly allowed", () => {
    expect(() => loadConfig({ ...base, ...sftp, APP_ENV: "local" })).toThrow(/localhost/);
    expect(
      loadConfig({ ...base, ...sftp, APP_ENV: "local", ALLOW_REMOTE_SERVICES: "true" })
        .ALLOW_REMOTE_SERVICES,
    ).toBe(true);
  });
  it("can never be allowed in tests or hosted environments", () => {
    expect(() =>
      loadConfig({ ...base, ...sftp, APP_ENV: "test", ALLOW_REMOTE_SERVICES: "true" }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...base, ...sftp, APP_ENV: "staging", ALLOW_REMOTE_SERVICES: "true" }),
    ).toThrow(/ALLOW_REMOTE_SERVICES/);
  });
});
