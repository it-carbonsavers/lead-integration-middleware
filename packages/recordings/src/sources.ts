/**
 * Picking up consent recordings that providers uploaded to OUR SFTP server.
 *
 * Each lead source has one SFTP account on SFTPGo. Its uploads are read from the uploads bucket
 * SFTPGo writes to, validated, stored encrypted,
 * matched to leads and then removed from the inbox: the encrypted copy is the only one kept.
 * A file whose processing failed stays in the inbox and is retried on the next scan; the
 * transfer ledger stops a file being processed twice.
 *
 * Every scan and connection test records last_checked_at / last_success_at / last_error on the
 * source's SFTP settings, which the dashboard shows.
 */

import { Socket } from "node:net";
import ssh2 from "ssh2";
import { sql, type Kysely } from "kysely";
import type { Database } from "@lim/db";
import { sshFingerprint } from "./files.js";
import type { UploadInbox } from "./inbox.js";
import { ingestRecording, type IngestDeps, type IngestOutcome } from "./ingest.js";
import { syncSftpAccount, type AccountProvisioner } from "./provisioner.js";

export interface ScanSummary {
  platform: string;
  seen: number;
  stored: number;
  duplicates: number;
  rejected: number;
  failed: number;
  alreadyProcessed: number;
  error?: string;
}

export interface SourceOptions {
  /** Only this platform (id); default: all active platforms with SFTP configured. */
  platformId?: string;
}

const tally = (s: ScanSummary, o: IngestOutcome) => {
  if (o.status === "stored") s.stored++;
  else if (o.status === "skipped_duplicate") s.duplicates++;
  else if (o.status === "rejected") s.rejected++;
  else s.alreadyProcessed++;
};

/** Records the outcome of a scan or connection test on the source's SFTP settings. */
export async function recordConnectionStatus(
  db: Kysely<Database>,
  platformId: string,
  result: { ok: boolean; error?: string | null; receivedFiles?: boolean },
) {
  await db
    .updateTable("platform_sftp_configs")
    .set({
      last_checked_at: sql`now()`,
      ...(result.ok
        ? { last_success_at: sql`now()`, last_error: null }
        : { last_error: result.error ?? "unknown_error" }),
      ...(result.receivedFiles ? { last_file_at: sql`now()` } : {}),
    })
    .where("platform_id", "=", platformId)
    .execute();
}

/** Process files waiting in each source's upload area. */
export async function scanHostedUploads(
  deps: IngestDeps,
  inbox: UploadInbox,
  opts: SourceOptions = {},
): Promise<ScanSummary[]> {
  let qb = deps.db
    .selectFrom("platform_sftp_configs as c")
    .innerJoin("platforms as p", "p.id", "c.platform_id")
    .select(["c.platform_id", "c.username", "p.code"])
    .where("p.status", "=", "active");
  if (opts.platformId) qb = qb.where("c.platform_id", "=", opts.platformId);

  const out: ScanSummary[] = [];
  for (const cfg of await qb.execute()) {
    const summary: ScanSummary = {
      platform: cfg.code,
      seen: 0,
      stored: 0,
      duplicates: 0,
      rejected: 0,
      failed: 0,
      alreadyProcessed: 0,
    };
    let files;
    try {
      files = await inbox.list(cfg.username);
    } catch {
      summary.error = "storage_unavailable";
      await recordConnectionStatus(deps.db, cfg.platform_id, { ok: false, error: summary.error });
      out.push(summary);
      continue;
    }
    for (const f of files) {
      summary.seen++;
      try {
        // Oversized files are rejected without being read into memory.
        const data =
          f.size > deps.maxBytes ? Buffer.alloc(0) : await inbox.read(cfg.username, f.name);
        const outcome = await ingestRecording(deps, {
          platformId: cfg.platform_id,
          mode: "sftp_hosted",
          remotePath: f.name,
          fileName: f.name,
          size: f.size,
          mtime: f.mtime,
          data,
        });
        tally(summary, outcome);
        await inbox.remove(cfg.username, f.name); // cleared from the upload area once processed
      } catch {
        summary.failed++; // left in place; retried on the next scan
      }
    }
    await recordConnectionStatus(deps.db, cfg.platform_id, {
      ok: summary.failed === 0,
      error: summary.failed ? "processing_failed" : null,
      receivedFiles: summary.seen > 0,
    });
    out.push(summary);
  }
  return out;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Plain-language result for the dashboard. */
  message: string;
  error?: string;
  files_waiting?: number;
}

export function tcpReachable(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("error", () => done(false));
    s.connect(port, host, () => done(true));
  });
}

/**
 * The SHA256 fingerprint of an SSH server's host key (what providers verify on first connect).
 * Connects, reads the key during the handshake and disconnects without logging in.
 */
export function serverHostKeyFingerprint(
  host: string,
  port: number,
  timeoutMs = 3_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const c = new ssh2.Client();
    let fp: string | null = null;
    const finish = () => {
      c.end();
      resolve(fp);
    };
    const timer = setTimeout(finish, timeoutMs);
    c.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    c.connect({
      host,
      port,
      username: "fingerprint-check",
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        void sshFingerprint(key).then((f) => {
          fp = f;
          verify(false); // stop here: no login attempt
        });
      },
    } as ssh2.ConnectConfig);
  });
}

/**
 * Tests a source's SFTP set-up and records the result:
 *  1. the account is pushed to the SFTP server again (SFTPGo) and must exist and be enabled
 *  2. the SFTP service must accept connections on the address providers use
 *  3. the source's upload area must be readable (reports how many files are waiting)
 */
export async function testSftpConnection(
  db: Kysely<Database>,
  platformId: string,
  rt: {
    inbox: UploadInbox | null;
    provisioner: AccountProvisioner;
    host: string | null;
    port: number | null;
  },
): Promise<ConnectionTestResult> {
  const cfg = await db
    .selectFrom("platform_sftp_configs as c")
    .innerJoin("platforms as p", "p.id", "c.platform_id")
    .select(["c.username", "c.auth_method", "c.password_hash", "c.authorized_keys", "p.status"])
    .where("c.platform_id", "=", platformId)
    .executeTakeFirst();
  if (!cfg)
    return { ok: false, error: "not_configured", message: "SFTP is not set up for this source." };

  if (rt.provisioner.kind === "none" || !rt.host || !rt.port)
    return {
      ok: false,
      error: "sftp_not_configured",
      message:
        "No SFTP server is connected in this environment. The account is created on SFTPGo once it is configured.",
    };
  const host = rt.host;
  const port = rt.port;
  const result = await (async (): Promise<ConnectionTestResult> => {
    const hasAuth =
      cfg.auth_method === "password" ? Boolean(cfg.password_hash) : cfg.authorized_keys.length > 0;
    if (!hasAuth)
      return {
        ok: false,
        error: "no_credentials",
        message: "The provider's account has no key or password yet.",
      };
    const sync = await syncSftpAccount(db, rt.provisioner, platformId);
    if (!sync.ok)
      return {
        ok: false,
        error: "account_sync_failed",
        message:
          "Could not update the provider's account on the SFTP server. Is the SFTP server (SFTPGo) running?",
      };
    const state = await rt.provisioner.state(cfg.username).catch(() => null);
    if (state && !state.exists)
      return {
        ok: false,
        error: "account_missing",
        message: "The provider's account does not exist on the SFTP server.",
      };
    if (!(await tcpReachable(host, port)))
      return {
        ok: false,
        error: "server_unreachable",
        message: `Our SFTP server (${host}:${port}) is not accepting connections. Is it running?`,
      };
    let waiting = 0;
    if (rt.inbox) {
      try {
        waiting = (await rt.inbox.list(cfg.username)).length;
      } catch {
        return {
          ok: false,
          error: "storage_unavailable",
          message: "The SFTP server is up, but the upload storage cannot be read.",
        };
      }
    }
    if (cfg.status !== "active")
      return {
        ok: true,
        message: `Account "${cfg.username}" is set up but disabled while this source is suspended.`,
        files_waiting: waiting,
      };
    return {
      ok: true,
      message: `Our SFTP server is reachable and account "${cfg.username}" is ready. ${waiting} file(s) waiting to be processed.`,
      files_waiting: waiting,
    };
  })();
  await recordConnectionStatus(db, platformId, { ok: result.ok, error: result.error ?? null });
  return result;
}
