/**
 * Provider accounts on our SFTP server.
 *
 * Our database is the source of truth (platform_sftp_configs). An `AccountProvisioner` pushes
 * each account to the SFTP server:
 *  - NoSftpServer          no SFTP server connected in this environment (e.g. local development):
 *                          settings are saved, and accounts are pushed once SFTPGo is configured.
 *  - SftpgoProvisioner     creates / updates / disables users through SFTPGo's admin REST API:
 *      * storage: the shared uploads bucket, prefix "<username>/" (the worker reads it from there)
 *      * permissions: list + upload (+ rename of own uploads, for clients that upload to a
 *        temporary name); no download, overwrite, delete or sub-folders
 *      * login: SSH public keys, or the argon2id password HASH we generated (SFTPGo accepts
 *        pre-hashed passwords, so the plain password never leaves the dashboard response)
 *      * SFTP only (FTP, WebDAV and the web client are refused), upload size limit
 */

import { sql, type Kysely } from "kysely";
import type { Database } from "@lim/db";
import type { S3Settings } from "./s3.js";

export interface SftpAccountSpec {
  username: string;
  enabled: boolean;
  authMethod: "key" | "password";
  passwordHash: string | null;
  publicKeys: string[];
}

export interface AccountState {
  exists: boolean;
  enabled: boolean;
}

export interface AccountProvisioner {
  readonly kind: "none" | "sftpgo";
  upsert(spec: SftpAccountSpec): Promise<void>;
  remove(username: string): Promise<void>;
  /** null when no SFTP server is connected. */
  state(username: string): Promise<AccountState | null>;
}

export class NoSftpServer implements AccountProvisioner {
  readonly kind = "none" as const;
  async upsert(): Promise<void> {
    throw new Error("sftp_not_configured");
  }
  async remove(): Promise<void> {}
  async state(): Promise<AccountState | null> {
    return null;
  }
}

export class SftpgoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SftpgoError";
  }
}

export interface SftpgoOptions {
  apiUrl: string;
  adminUser: string;
  adminPassword: string;
  /** Uploads bucket as SFTPGo reaches it. */
  storage: S3Settings & { bucket: string; prefix?: string };
  maxUploadBytes: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const KEY_LOGIN_DENIED = [
  "password",
  "keyboard-interactive",
  "publickey+password",
  "publickey+keyboard-interactive",
];
const PASSWORD_LOGIN_DENIED = [
  "publickey",
  "keyboard-interactive",
  "publickey+password",
  "publickey+keyboard-interactive",
];

export class SftpgoProvisioner implements AccountProvisioner {
  readonly kind = "sftpgo" as const;
  private token: { value: string; expires: number } | null = null;
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: SftpgoOptions) {
    this.base = `${opts.apiUrl.replace(/\/+$/, "")}/api/v2`;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.opts.adminUser}:${this.opts.adminPassword}`).toString(
      "base64",
    );
    const res = await this.fetch(`${this.base}/token`, {
      headers: { authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new SftpgoError("sftpgo_auth_failed", res.status);
    const body = (await res.json()) as { access_token: string; expires_at?: string };
    const expires = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 10 * 60_000;
    this.token = { value: body.access_token, expires };
    return body.access_token;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<Response> {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.getToken()}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (res.status === 401 && !retried) {
      this.token = null;
      return this.call(method, path, body, true);
    }
    return res;
  }

  private userBody(spec: SftpAccountSpec) {
    const s = this.opts.storage;
    return {
      username: spec.username,
      status: spec.enabled ? 1 : 0,
      description: "Consent recording uploads for a lead source (managed by the middleware)",
      ...(spec.authMethod === "password" && spec.passwordHash
        ? { password: spec.passwordHash }
        : {}),
      public_keys: spec.authMethod === "key" ? spec.publicKeys : [],
      permissions: { "/": ["list", "upload", "rename_files"] },
      filesystem: {
        provider: 1, // S3-compatible
        s3config: {
          bucket: s.bucket,
          region: s.region,
          endpoint: s.endpoint,
          access_key: s.accessKeyId,
          access_secret: { status: "Plain", payload: s.secretAccessKey },
          key_prefix: `${s.prefix ?? ""}${spec.username}/`,
          force_path_style: s.forcePathStyle,
        },
      },
      filters: {
        denied_login_methods: spec.authMethod === "key" ? KEY_LOGIN_DENIED : PASSWORD_LOGIN_DENIED,
        denied_protocols: ["FTP", "DAV", "HTTP"],
        max_upload_file_size: this.opts.maxUploadBytes,
      },
    };
  }

  async upsert(spec: SftpAccountSpec): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(spec.username))
      throw new SftpgoError("invalid_username");
    const path = `/users/${encodeURIComponent(spec.username)}`;
    const existing = await this.call("GET", path);
    const res =
      existing.status === 404
        ? await this.call("POST", "/users", this.userBody(spec))
        : existing.ok
          ? await this.call("PUT", path, this.userBody(spec))
          : existing;
    if (!res.ok) throw new SftpgoError(`sftpgo_${res.status}: ${await safeError(res)}`, res.status);
  }

  async remove(username: string): Promise<void> {
    const res = await this.call("DELETE", `/users/${encodeURIComponent(username)}`);
    if (!res.ok && res.status !== 404)
      throw new SftpgoError(`sftpgo_${res.status}: ${await safeError(res)}`, res.status);
  }

  async state(username: string): Promise<AccountState | null> {
    const res = await this.call("GET", `/users/${encodeURIComponent(username)}`);
    if (res.status === 404) return { exists: false, enabled: false };
    if (!res.ok) throw new SftpgoError(`sftpgo_${res.status}`, res.status);
    const u = (await res.json()) as { status: number };
    return { exists: true, enabled: u.status === 1 };
  }
}

/** SFTPGo error text, without anything that could echo a secret back. */
async function safeError(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { message?: string; error?: string };
    return String(b.error ?? b.message ?? "")
      .replace(/\$argon2[^\s"]*/g, "[hash]")
      .slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * Pushes one lead source's account to the SFTP server (create/update, disabled while the source
 * is suspended) and records the outcome. Returns false if the server could not be updated; the
 * dashboard shows the error and "Test connection" tries again.
 */
export async function syncSftpAccount(
  db: Kysely<Database>,
  provisioner: AccountProvisioner,
  platformId: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = await db
    .selectFrom("platform_sftp_configs as c")
    .innerJoin("platforms as p", "p.id", "c.platform_id")
    .select(["c.username", "c.auth_method", "c.password_hash", "c.authorized_keys", "p.status"])
    .where("c.platform_id", "=", platformId)
    .executeTakeFirst();
  if (!row) return { ok: true };
  // Nothing to push to yet: the account is created when SFTPGo is connected (Test connection).
  if (provisioner.kind === "none") return { ok: false, error: "sftp_not_configured" };
  try {
    await provisioner.upsert({
      username: row.username,
      enabled: row.status === "active",
      authMethod: row.auth_method,
      passwordHash: row.password_hash,
      publicKeys: row.authorized_keys,
    });
    await db
      .updateTable("platform_sftp_configs")
      .set({
        account_synced_at: sql`now()`,
        last_error: sql`CASE WHEN last_error = 'account_sync_failed' THEN NULL ELSE last_error END`,
      })
      .where("platform_id", "=", platformId)
      .execute();
    return { ok: true };
  } catch {
    await db
      .updateTable("platform_sftp_configs")
      .set({ last_error: "account_sync_failed", last_checked_at: sql`now()` })
      .where("platform_id", "=", platformId)
      .execute();
    return { ok: false, error: "account_sync_failed" };
  }
}
