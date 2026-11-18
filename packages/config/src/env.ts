/**
 * Environment configuration.
 *
 * Every setting is read from environment variables and validated once at boot with zod.
 * Secrets are never hard-coded, logged or echoed back: validation errors name the variable
 * and the rule it broke, never the value.
 */

import { isAbsolute } from "node:path";
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Accepts a base64 string that decodes to exactly 32 bytes (256-bit key). */
const key32 = z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
  message: "must be base64 encoding exactly 32 bytes (generate with: openssl rand -base64 32)",
});

const absolutePath = z.string().refine(isAbsolute, { message: "must be an absolute path" });

const intFromEnv = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Deployment environment. Also embedded in provider API keys so keys cannot cross environments. */
    APP_ENV: z.enum(["local", "test", "staging", "production"]).default("local"),
    PORT: intFromEnv(3000, 1, 65535),
    HOST: z.string().min(1).default("0.0.0.0"),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, { message: "must be a postgres:// connection string" }),
    DATABASE_POOL_MAX: intFromEnv(10, 1, 100),
    /** disable = local dev; require = TLS with certificate verification; no-verify = TLS without CA check */
    DATABASE_SSL: z.enum(["disable", "require", "no-verify"]).default("disable"),

    /**
     * Number of reverse proxies in front of the service (Railway edge = 1).
     * Used to read the real client IP from X-Forwarded-For without trusting spoofed entries.
     */
    TRUST_PROXY_HOPS: intFromEnv(0, 0, 5),
    BODY_LIMIT_BYTES: intFromEnv(65_536, 1_024, 1_048_576),

    /** Per-client-IP request ceiling on the provider API (applies before authentication). */
    RATE_LIMIT_IP_PER_MIN: intFromEnv(300, 1, 100_000),
    /** Default per-platform ceiling; each platform can override it in the database. */
    RATE_LIMIT_PLATFORM_DEFAULT_PER_MIN: intFromEnv(60, 1, 100_000),

    /** AES-256-GCM key for application-level encryption of personal data (email, phone, address...). */
    APP_ENCRYPTION_KEY: key32,
    /** HMAC key for blind indexes (exact-match search and duplicate checks over encrypted fields). */
    APP_BLIND_INDEX_KEY: key32,

    /** How often (seconds) a credential's last_used_at is refreshed, to avoid a write per request. */
    API_KEY_LAST_USED_THROTTLE_SECONDS: intFromEnv(300, 0, 86_400),

    // --- Lead processing (Phase 3) ------------------------------------------------
    /** ISO 3166 alpha-2 region used to parse phone numbers given without a country code. */
    DEFAULT_PHONE_REGION: z
      .string()
      .regex(/^[A-Z]{2}$/, { message: "must be an ISO 3166 alpha-2 code, e.g. AU" })
      .default("AU"),
    /** A lead with the same phone or email seen within this many days is flagged as a possible duplicate. */
    DUPLICATE_WINDOW_DAYS: intFromEnv(30, 1, 3_650),
    /** Lead personal data is kept this long, then deleted or anonymised (retention job: later phase). */
    LEAD_RETENTION_DAYS: intFromEnv(730, 1, 3_650),
    /** Delivery retries after the first failed attempt before a lead is dead-lettered. */
    DELIVERY_RETRY_LIMIT: intFromEnv(8, 0, 20),
    /** First retry delay (seconds); grows exponentially with jitter, capped at DELIVERY_RETRY_DELAY_MAX_SECONDS. */
    DELIVERY_RETRY_DELAY_SECONDS: intFromEnv(60, 1, 3_600),
    DELIVERY_RETRY_DELAY_MAX_SECONDS: intFromEnv(21_600, 1, 86_400),
    /** Delivery jobs fetched per batch (processed in parallel, settled individually). */
    DELIVERY_BATCH_SIZE: intFromEnv(10, 1, 100),
    /** Maximum concurrent deliveries per worker instance (protects destination rate limits). */
    DELIVERY_CONCURRENCY: intFromEnv(4, 1, 50),
    /**
     * Master switch for real HubSpot calls. Default false: during local development all leads go to
     * the mock destination and the HubSpot adapter refuses to make network calls.
     */
    HUBSPOT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // --- Consent recordings and SFTP (Phase 5) -----------------------------------
    /** Absolute directory for encrypted recording files (local stand-in for private object storage). */
    RECORDING_STORAGE_DIR: absolutePath.optional(),
    RECORDING_MAX_MB: intFromEnv(50, 1, 500),
    RECORDING_RETENTION_DAYS: intFromEnv(730, 1, 3_650),
    /** Raw (encrypted) submission payloads are removed after this many days. */
    PAYLOAD_RETENTION_DAYS: intFromEnv(90, 1, 3_650),
    /** A lead still waiting for its consent recording after this many hours is marked overdue. */
    CONSENT_OVERDUE_HOURS: intFromEnv(48, 1, 2_160),
    /**
     * The SFTP server providers upload consent recordings to: SFTPGo (on Railway), storing uploads
     * in an S3-compatible bucket. Provider accounts are pushed to SFTPGo through its admin REST API.
     * Leave all SFTPGO_* settings unset to run without an SFTP server (e.g. local development):
     * recording settings can still be edited, and accounts are pushed once SFTPGo is connected.
     */
    /** Address providers connect to (Railway: the SFTPGo service's TCP proxy host and port). */
    SFTP_PUBLIC_HOST: z.string().optional(),
    SFTP_PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    /** SFTPGo admin REST API (Railway: private network address, e.g. http://sftpgo.railway.internal:8080). */
    SFTPGO_API_URL: z
      .string()
      .regex(/^https?:\/\//)
      .optional(),
    SFTPGO_ADMIN_USER: z.string().optional(),
    SFTPGO_ADMIN_PASSWORD: z.string().optional(),
    /** S3 endpoint as SFTPGo reaches it (inside Docker / private network). Defaults to S3_ENDPOINT. */
    SFTPGO_S3_ENDPOINT: z
      .string()
      .regex(/^https?:\/\//)
      .optional(),

    // --- S3-compatible object storage (uploads inbox, optional recording store) ---------
    S3_ENDPOINT: z
      .string()
      .regex(/^https?:\/\//)
      .optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /** Bucket SFTPGo writes provider uploads into (one prefix per provider account). */
    UPLOADS_BUCKET: z.string().optional(),
    /** Folder inside the uploads bucket, e.g. "uploads/" when uploads and recordings share one bucket. */
    UPLOADS_PREFIX: z
      .string()
      .regex(
        /^([a-z0-9][a-z0-9_-]{0,40}\/)?$/,
        'empty, or a folder name ending in "/", e.g. uploads/',
      )
      .default(""),
    /** Where encrypted recordings are kept: local folder (RECORDING_STORAGE_DIR) or a private bucket. */
    RECORDING_STORE: z.enum(["local", "s3"]).default("local"),
    RECORDINGS_BUCKET: z.string().optional(),

    // --- Admin backend ---------------------------------------------------------
    /** Time zone for report date filters and grouping (IANA name). */
    REPORT_TIMEZONE: z
      .string()
      .refine(
        (tz) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        },
        { message: "must be an IANA time zone, e.g. Australia/Sydney" },
      )
      .default("Australia/Sydney"),
    /** Absolute session lifetime and idle timeout for admin sign-in. */
    ADMIN_SESSION_HOURS: intFromEnv(8, 1, 24),
    ADMIN_SESSION_IDLE_MINUTES: intFromEnv(30, 5, 480),
    /** Admin API requests allowed per client IP per minute (all admin endpoints). */
    ADMIN_RATE_PER_MIN: intFromEnv(600, 10, 100_000),
    /** Sign-in attempts allowed per client IP per minute (on top of per-account lockout). */
    ADMIN_LOGIN_RATE_PER_MIN: intFromEnv(10, 1, 10_000),
    /** Failed sign-ins before an account is locked, and for how long. */
    ADMIN_LOCKOUT_THRESHOLD: intFromEnv(5, 3, 20),
    ADMIN_LOCKOUT_MINUTES: intFromEnv(15, 1, 1_440),
    /** Mark the session cookie Secure. Browsers accept Secure cookies on http://localhost. */
    ADMIN_COOKIE_SECURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /** HubSpot API base URL (override only for tests). */
    HUBSPOT_BASE_URL: z
      .string()
      .regex(/^https?:\/\//)
      .default("https://api.hubapi.com"),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENCRYPTION_KEY && env.APP_ENCRYPTION_KEY === env.APP_BLIND_INDEX_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_BLIND_INDEX_KEY"],
        message: "must differ from APP_ENCRYPTION_KEY",
      });
    }
    const need = (cond: boolean, names: (keyof typeof env)[], why: string) => {
      if (!cond) return;
      for (const n of names)
        if (!env[n]) ctx.addIssue({ code: "custom", path: [n], message: `required when ${why}` });
    };
    const s3 = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
    // SFTPGo is all-or-nothing: setting any of these means the full set is required.
    need(
      Boolean(env.SFTPGO_API_URL || env.SFTPGO_ADMIN_USER || env.SFTPGO_ADMIN_PASSWORD),
      [
        "SFTPGO_API_URL",
        "SFTPGO_ADMIN_USER",
        "SFTPGO_ADMIN_PASSWORD",
        "SFTP_PUBLIC_HOST",
        "SFTP_PUBLIC_PORT",
        "UPLOADS_BUCKET",
        ...s3,
      ],
      "an SFTPGo server is configured",
    );
    need(env.RECORDING_STORE === "s3", ["RECORDINGS_BUCKET", ...s3], "RECORDING_STORE=s3");
    if (
      env.UPLOADS_BUCKET &&
      env.UPLOADS_BUCKET === env.RECORDINGS_BUCKET &&
      env.RECORDING_STORE === "s3" &&
      (env.UPLOADS_PREFIX === "" || env.UPLOADS_PREFIX === "recordings/")
    )
      ctx.addIssue({
        code: "custom",
        path: ["UPLOADS_PREFIX"],
        message: 'must be set (e.g. "uploads/") when uploads and recordings share one bucket',
      });
    // Local development and tests must never reach a real (e.g. Railway) SFTP server or bucket.
    if (env.APP_ENV === "local" || env.APP_ENV === "test") {
      for (const n of ["SFTPGO_API_URL", "S3_ENDPOINT"] as const) {
        const v = env[n];
        if (v && !isLocalUrl(v))
          ctx.addIssue({
            code: "custom",
            path: [n],
            message: "must point at this computer (localhost) when APP_ENV is local or test",
          });
      }
    }
    // Unencrypted database connections are only acceptable in production over Railway's
    // private network (*.railway.internal), which never leaves the project.
    if (
      env.DATABASE_SSL === "disable" &&
      env.APP_ENV === "production" &&
      !isPrivateNetworkHost(env.DATABASE_URL)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_SSL"],
        message:
          "must not be 'disable' in production for a public database host; set 'require' or 'no-verify', or use the private-network hostname",
      });
    }
  });

function isLocalUrl(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isPrivateNetworkHost(databaseUrl: string): boolean {
  try {
    return new URL(databaseUrl).hostname.endsWith(".railway.internal");
  } catch {
    return false;
  }
}

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Parses and validates configuration from the given environment (defaults to process.env).
 * Throws ConfigError listing variable names and rules only, never values.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings as "unset" so optional variables with blank values do not fail validation.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`),
    );
  }
  return result.data;
}

/** Short environment tag used inside API keys: lim_<tag>_... */
export function apiKeyEnvTag(appEnv: Env["APP_ENV"]): "live" | "stg" | "dev" | "test" {
  switch (appEnv) {
    case "production":
      return "live";
    case "staging":
      return "stg";
    case "test":
      return "test";
    default:
      return "dev";
  }
}
