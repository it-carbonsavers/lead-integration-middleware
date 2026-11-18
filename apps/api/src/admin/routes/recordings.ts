/**
 * Admin endpoints for consent recordings and SFTP transfers.
 *   GET  /recordings                 list (scoped for provider users)              recordings.read
 *   GET  /recordings/:id/audio       stream the decrypted audio (audited)           recordings.play
 *   POST /recordings/:id/link        link an unmatched recording to a lead          recordings.link
 *   GET  /transfers                  SFTP transfer log (scoped for provider users)   recordings.read
 *   POST /transfers/scan             pick up recordings now (all or one source)      platforms.manage
 *   POST /transfers/:id/retry        retry a failed transfer                         platforms.manage
 *   GET  /platforms/:code/sftp       source SFTP settings + status (no secrets)      platforms.manage
 *   PUT  /platforms/:code/sftp       save the provider's account (pushed to the SFTP server)
 *   POST /platforms/:code/sftp/test      test the set-up now (re-pushes the account)
 *   POST /platforms/:code/sftp/password  issue a new password (shown once; only the hash is kept)
 */

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql } from "kysely";
import ssh2 from "ssh2";
import { z } from "zod";
import { problems, QUEUES } from "@lim/core";
import { writeAudit } from "@lim/db";
import {
  linkRecording,
  RecordingLinkError,
  recordingStore,
  serverHostKeyFingerprint,
  sftpRuntime,
  syncSftpAccount,
  testSftpConnection,
} from "@lim/recordings";
import { actorOf, generatePassword, hashPassword, requirePermission } from "../auth.js";
import { dayEnd, dayStart } from "../lead-query.js";
import type { AdminRouteOptions } from "./index.js";

const idParam = z.object({ id: z.uuid() });
const codeParam = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{2,15}$/) });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function publicKeyFingerprint(key: string): string | null {
  const parsed = ssh2.utils.parseKey(key);
  const k = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!k || k instanceof Error || k.isPrivateKey()) return null;
  return `SHA256:${createHash("sha256").update(k.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
}

export async function adminRecordingRoutes(app: FastifyInstance, opts: AdminRouteOptions) {
  const { db, config, boss } = opts;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const store = recordingStore(config);
  const rt = opts.sftp ?? sftpRuntime(config);

  r.get(
    "/recordings",
    {
      preHandler: requirePermission("recordings.read"),
      schema: {
        querystring: z.object({
          status: z.enum(["matched", "unmatched", "rejected", "deleted"]).optional(),
          platform: z.string().max(16).optional(),
          q: z.string().trim().max(200).optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const a = req.admin!;
      let qb = db
        .selectFrom("consent_recordings as r")
        .innerJoin("platforms as p", "p.id", "r.platform_id")
        .leftJoin("leads as l", "l.id", "r.lead_id");
      if (a.platformId) qb = qb.where("r.platform_id", "=", a.platformId);
      if (a.organisationId) qb = qb.where("r.organisation_id", "=", a.organisationId);
      if (q.status) qb = qb.where("r.status", "=", q.status);
      if (q.platform) qb = qb.where("p.code", "=", q.platform);
      if (q.q)
        qb = qb.where((eb) =>
          eb.or([
            eb("r.original_filename", "=", q.q!),
            eb("r.recording_ref", "=", q.q!),
            eb("l.lead_ref", "=", q.q!),
          ]),
        );
      if (q.from) qb = qb.where("r.created_at", ">=", dayStart(q.from, config.REPORT_TIMEZONE));
      if (q.to) qb = qb.where("r.created_at", "<", dayEnd(q.to, config.REPORT_TIMEZONE));
      const [{ total }] = (await qb.select(sql<number>`count(*)::int`.as("total")).execute()) as [
        { total: number },
      ];
      const items = await qb
        .select([
          "r.id",
          "r.created_at",
          "p.code as platform",
          "r.original_filename",
          "r.recording_ref",
          "r.status",
          "r.rejection_reason",
          "r.size_bytes",
          "r.content_type",
          "r.matched_by",
          "r.matched_at",
          "l.lead_ref",
          "r.retention_until",
        ])
        .orderBy("r.created_at", "desc")
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute();
      return { items, total, page: q.page, pageSize: q.pageSize };
    },
  );

  r.get(
    "/recordings/:id/audio",
    { preHandler: requirePermission("recordings.play"), schema: { params: idParam } },
    async (req, reply) => {
      const a = req.admin!;
      let qb = db.selectFrom("consent_recordings").selectAll().where("id", "=", req.params.id);
      if (a.platformId) qb = qb.where("platform_id", "=", a.platformId);
      if (a.organisationId) qb = qb.where("organisation_id", "=", a.organisationId);
      const rec = await qb.executeTakeFirst();
      if (!rec || !rec.storage_key || !store) throw problems.notFound();
      const audio = await store.get(rec.storage_key);
      await writeAudit(db, {
        actorType: "admin",
        actorId: a.id,
        actorLabel: a.email,
        organisationId: rec.organisation_id,
        action: "recording.played",
        targetType: "recording",
        targetId: rec.id,
        requestId: req.id,
        ip: req.ip,
        detail: { file: rec.original_filename },
      });
      return reply
        .header("content-type", rec.content_type ?? "application/octet-stream")
        .header("content-disposition", "inline")
        .header("cache-control", "no-store")
        .send(audio);
    },
  );

  r.post(
    "/recordings/:id/link",
    {
      preHandler: requirePermission("recordings.link"),
      schema: {
        params: idParam,
        body: z.strictObject({ lead_ref: z.string().regex(/^LD-[0-9A-Z]{26}$/) }),
      },
    },
    async (req) => {
      try {
        await linkRecording(
          {
            db,
            onMatched: async (leadId) =>
              void (await boss.send(QUEUES.syncConsent.name, { leadId })),
          },
          req.params.id,
          req.body.lead_ref,
          actorOf(req),
        );
      } catch (e) {
        if (e instanceof RecordingLinkError) throw problems.conflict(e.message);
        throw e;
      }
      return { ok: true };
    },
  );

  r.get(
    "/transfers",
    {
      preHandler: requirePermission("recordings.read"),
      schema: {
        querystring: z.object({
          status: z
            .enum(["transferring", "stored", "rejected", "failed", "skipped_duplicate"])
            .optional(),
          platform: z.string().max(16).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const a = req.admin!;
      let qb = db
        .selectFrom("transfer_jobs as t")
        .innerJoin("platforms as p", "p.id", "t.platform_id")
        .leftJoin("consent_recordings as r", "r.id", "t.recording_id")
        .leftJoin("leads as l", "l.id", "r.lead_id");
      if (a.platformId) qb = qb.where("t.platform_id", "=", a.platformId);
      if (a.organisationId) qb = qb.where("p.organisation_id", "=", a.organisationId);
      if (q.status) qb = qb.where("t.status", "=", q.status);
      if (q.platform) qb = qb.where("p.code", "=", q.platform);
      const [{ total }] = (await qb.select(sql<number>`count(*)::int`.as("total")).execute()) as [
        { total: number },
      ];
      const items = await qb
        .select([
          "t.id",
          "t.started_at",
          "t.finished_at",
          "p.code as platform",
          "t.mode",
          "t.remote_path",
          "t.remote_size",
          "t.status",
          "t.attempts",
          "t.error_code",
          "r.status as recording_status",
          "l.lead_ref",
        ])
        .orderBy("t.started_at", "desc")
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute();
      return { items, total, page: q.page, pageSize: q.pageSize };
    },
  );

  const managePerm = requirePermission("platforms.manage", { internalOnly: true });
  const audit = (
    req: Parameters<typeof actorOf>[0],
    action:
      | "transfer.scan_requested"
      | "platform.sftp_updated"
      | "platform.sftp_tested"
      | "transfer.retry_requested",
    detail: Record<string, unknown>,
    target?: { type: string; id: string; org?: string },
  ) =>
    writeAudit(db, {
      actorType: "admin",
      actorId: req.admin!.id,
      actorLabel: req.admin!.email,
      organisationId: target?.org ?? null,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      requestId: req.id,
      ip: req.ip,
      detail,
    });
  const platformByCode = async (code: string) => {
    const p = await db
      .selectFrom("platforms")
      .select(["id", "code", "organisation_id", "recording_ingest_mode"])
      .where("code", "=", code)
      .executeTakeFirst();
    if (!p) throw problems.notFound();
    return p;
  };

  /** Pick up recordings now: all sources, or one source (body.platform). */
  r.post(
    "/transfers/scan",
    {
      preHandler: managePerm,
      schema: { body: z.strictObject({ platform: z.string().max(16).optional() }).optional() },
    },
    async (req) => {
      const code = req.body?.platform;
      const p = code ? await platformByCode(code) : null;
      await boss.send(QUEUES.recordingsScan.name, p ? { platformId: p.id } : {});
      await boss.send(QUEUES.recordingsMaintenance.name, {});
      await audit(req, "transfer.scan_requested", { platform: code ?? "all" });
      return { ok: true, queued: true };
    },
  );

  /** Retry a failed transfer: the file is still at the source, so a scan of that source re-processes it. */
  r.post(
    "/transfers/:id/retry",
    { preHandler: managePerm, schema: { params: idParam } },
    async (req) => {
      const job = await db
        .selectFrom("transfer_jobs as t")
        .innerJoin("platforms as p", "p.id", "t.platform_id")
        .select([
          "t.id",
          "t.status",
          "t.platform_id",
          "t.remote_path",
          "p.code",
          "p.organisation_id",
        ])
        .where("t.id", "=", req.params.id)
        .executeTakeFirst();
      if (!job) throw problems.notFound();
      if (job.status !== "failed")
        throw problems.conflict(`Only failed transfers can be retried (status is ${job.status})`);
      await boss.send(QUEUES.recordingsScan.name, { platformId: job.platform_id });
      await audit(
        req,
        "transfer.retry_requested",
        { platform: job.code, file: job.remote_path },
        { type: "transfer", id: job.id, org: job.organisation_id },
      );
      return { ok: true, queued: true };
    },
  );

  // Our SFTP server's host-key fingerprint, which providers check on first connect.
  let fpCache: { value: string | null; at: number; addr: string } | null = null;
  const hostKeyFingerprint = async () => {
    if (!rt.host || !rt.port) return null;
    const addr = `${rt.host}:${rt.port}`;
    if (
      !fpCache ||
      fpCache.addr !== addr ||
      (fpCache.value === null && Date.now() - fpCache.at > 15_000)
    ) {
      fpCache = { value: await serverHostKeyFingerprint(rt.host, rt.port), at: Date.now(), addr };
    }
    return fpCache.value;
  };
  const hostedServerInfo = async () => ({
    server: rt.backend === "sftpgo" ? "SFTPGo" : null,
    host: rt.host,
    port: rt.port,
    host_key_fingerprint: await hostKeyFingerprint(),
    upload_directory: "/",
    max_file_mb: config.RECORDING_MAX_MB,
  });

  /** SFTP settings for a source. Secrets are never returned: only whether they are set. */
  r.get(
    "/platforms/:code/sftp",
    { preHandler: managePerm, schema: { params: codeParam } },
    async (req) => {
      const p = await platformByCode(req.params.code);
      const cfg = await db
        .selectFrom("platform_sftp_configs")
        .selectAll()
        .where("platform_id", "=", p.id)
        .executeTakeFirst();
      const files = await db
        .selectFrom("transfer_jobs")
        .select([
          sql<number>`count(*) FILTER (WHERE status = 'stored')::int`.as("stored"),
          sql<number>`count(*) FILTER (WHERE status = 'failed')::int`.as("failed"),
          sql<number>`count(*) FILTER (WHERE status = 'rejected')::int`.as("rejected"),
          sql<Date | null>`max(started_at)`.as("last_transfer_at"),
        ])
        .where("platform_id", "=", p.id)
        .executeTakeFirstOrThrow();
      return {
        mode: p.recording_ingest_mode,
        config: cfg
          ? {
              username: cfg.username,
              auth_method: cfg.auth_method,
              authorized_keys: cfg.authorized_keys.map((k) => ({
                fingerprint: publicKeyFingerprint(k),
                comment: k.split(" ")[2] ?? "",
              })),
              password_set: Boolean(cfg.password_hash),
              account_synced_at: cfg.account_synced_at,
              last_checked_at: cfg.last_checked_at,
              last_success_at: cfg.last_success_at,
              last_error: cfg.last_error,
              last_file_at: cfg.last_file_at,
            }
          : null,
        transfers: files,
        our_server: await hostedServerInfo(),
      };
    },
  );

  const hostedBody = z.strictObject({
    mode: z.literal("sftp_hosted"),
    username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/, "3-32 chars: a-z 0-9 _ -"),
    auth_method: z.enum(["key", "password"]).default("key"),
    authorized_keys: z.array(z.string().trim().min(20).max(5_000)).max(10).optional(),
  });
  r.put(
    "/platforms/:code/sftp",
    {
      preHandler: managePerm,
      schema: {
        params: codeParam,
        body: z.discriminatedUnion("mode", [
          z.strictObject({ mode: z.literal("none") }),
          hostedBody,
        ]),
      },
    },
    async (req, reply) => {
      const p = await platformByCode(req.params.code);
      const b = req.body;
      const existing = await db
        .selectFrom("platform_sftp_configs")
        .selectAll()
        .where("platform_id", "=", p.id)
        .executeTakeFirst();
      let detail: Record<string, unknown> = { mode: b.mode };
      let generatedPassword: string | null = null;
      let accountSync: { ok: boolean; error?: string } = { ok: true };

      if (b.mode === "none") {
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable("platforms")
            .set({ recording_ingest_mode: "none" })
            .where("id", "=", p.id)
            .execute();
          await trx.deleteFrom("platform_sftp_configs").where("platform_id", "=", p.id).execute();
        });
        if (existing) await removeAccount(existing.username);
      } else {
        const keys =
          b.auth_method === "key" ? (b.authorized_keys ?? existing?.authorized_keys ?? []) : [];
        const fps = keys.map(publicKeyFingerprint);
        if (fps.some((f) => f === null))
          throw problems.validation([{ path: "authorized_keys", code: "invalid_public_key" }]);
        if (b.auth_method === "key" && keys.length === 0)
          throw problems.validation([{ path: "authorized_keys", code: "required" }]);
        const taken = await db
          .selectFrom("platform_sftp_configs")
          .select("platform_id")
          .where("username", "=", b.username)
          .where("platform_id", "!=", p.id)
          .executeTakeFirst();
        if (taken) throw problems.conflict("That SFTP username is used by another lead source");
        let passwordHash = existing?.password_hash ?? null;
        if (b.auth_method === "password" && !passwordHash) {
          generatedPassword = generatePassword();
          passwordHash = await hashPassword(generatedPassword);
        }
        const values = {
          mode: "sftp_hosted" as const,
          username: b.username,
          auth_method: b.auth_method,
          authorized_keys: keys,
          password_hash: b.auth_method === "password" ? passwordHash : null,
        };
        await save(p.id, values);
        if (existing && existing.username !== b.username) await removeAccount(existing.username);
        accountSync = await syncSftpAccount(db, rt.provisioner, p.id);
        detail = {
          mode: b.mode,
          username: b.username,
          auth_method: b.auth_method,
          key_fingerprints: fps,
          password_generated: Boolean(generatedPassword),
        };
      }
      await audit(
        req,
        "platform.sftp_updated",
        { platform: p.code, ...detail },
        { type: "platform", id: p.id, org: p.organisation_id },
      );
      reply.header("cache-control", "no-store");
      const syncWarning = accountSync.ok
        ? {}
        : {
            account_sync_error:
              accountSync.error === "sftp_not_configured"
                ? "Saved. No SFTP server is connected in this environment yet; the account is created on SFTPGo when it is (press Test connection then)."
                : "Saved, but the SFTP server could not be updated. Check it is running, then press Test connection.",
          };
      return generatedPassword
        ? {
            ok: true,
            generated_password: generatedPassword,
            warning: "Shown once. Send it to the provider over a secure channel.",
            ...syncWarning,
          }
        : { ok: true, ...syncWarning };
    },
  );

  /** Removes an account from the SFTP server (SFTPGo); files already uploaded stay in storage. */
  async function removeAccount(username: string) {
    await rt.provisioner
      .remove(username)
      .catch((err: unknown) =>
        app.log.warn(
          { err: err instanceof Error ? err.message : err },
          "sftp account removal failed",
        ),
      );
  }

  async function save(
    platformId: string,
    values: Record<string, unknown> & { mode: "sftp_hosted" },
  ) {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("platforms")
        .set({ recording_ingest_mode: values.mode })
        .where("id", "=", platformId)
        .execute();
      await trx
        .insertInto("platform_sftp_configs")
        .values({ platform_id: platformId, ...(values as object) } as never)
        .onConflict((oc) => oc.column("platform_id").doUpdateSet(values as never))
        .execute();
    });
  }

  /** Option A password: issue a new one (old one stops working). Shown once. */
  r.post(
    "/platforms/:code/sftp/password",
    { preHandler: managePerm, schema: { params: codeParam } },
    async (req, reply) => {
      const p = await platformByCode(req.params.code);
      const cfg = await db
        .selectFrom("platform_sftp_configs")
        .select(["mode", "auth_method"])
        .where("platform_id", "=", p.id)
        .executeTakeFirst();
      if (!cfg || cfg.auth_method !== "password") {
        throw problems.conflict("This source does not use password login on our SFTP server");
      }
      const pw = generatePassword();
      await db
        .updateTable("platform_sftp_configs")
        .set({ password_hash: await hashPassword(pw) })
        .where("platform_id", "=", p.id)
        .execute();
      const sync = await syncSftpAccount(db, rt.provisioner, p.id);
      await audit(
        req,
        "platform.sftp_updated",
        { platform: p.code, password_regenerated: true },
        { type: "platform", id: p.id, org: p.organisation_id },
      );
      reply.header("cache-control", "no-store");
      return {
        generated_password: pw,
        warning: "Shown once. The previous password no longer works.",
        ...(sync.ok || sync.error === "sftp_not_configured"
          ? {}
          : {
              account_sync_error:
                "Saved, but the SFTP server could not be updated yet. Press Test connection once it is running.",
            }),
      };
    },
  );

  /** Test the source's SFTP connection now and record the result. */
  r.post(
    "/platforms/:code/sftp/test",
    { preHandler: managePerm, schema: { params: codeParam } },
    async (req) => {
      const p = await platformByCode(req.params.code);
      const result = await testSftpConnection(db, p.id, rt);
      await audit(
        req,
        "platform.sftp_tested",
        { platform: p.code, ok: result.ok, error: result.error ?? null },
        { type: "platform", id: p.id, org: p.organisation_id },
      );
      return result;
    },
  );
}
