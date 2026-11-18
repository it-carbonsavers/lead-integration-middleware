/**
 * Consent Recording Management: ingest, validate, store, match.
 *
 * Every file that arrives (from either SFTP option) goes through `ingestRecording`:
 *   1. ledger      transfer_jobs (platform, path, size, mtime) - a file is never processed twice
 *   2. validate    safe name, allowed extension, size limit, real audio content (magic bytes)
 *   3. dedupe      same SHA-256 from the same provider -> skipped_duplicate
 *   4. store       encrypted, under a random key
 *   5. match       to a lead of the same provider (recording_ref, naming convention, external id)
 * Rejected and unmatched files are recorded so operators (and the provider portal) can see them.
 */

import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { writeAudit, type Actor, type ConsentRecording, type Database } from "@lim/db";
import { detectAudio, matchCandidates, parseRecordingName, RECORDING_EXTENSIONS } from "./files.js";
import { newRecordingKey, type ObjectStore } from "./storage.js";

export interface IngestDeps {
  db: Kysely<Database>;
  store: ObjectStore;
  maxBytes: number;
  retentionDays: number;
  /** Called after a recording is matched to a lead (e.g. to sync consent status to the CRM). */
  onMatched?: (leadId: string) => Promise<void>;
}

export interface IncomingFile {
  platformId: string;
  mode: "sftp_hosted";
  remotePath: string;
  fileName: string;
  size: number;
  mtime: Date;
  data: Buffer;
}

export type IngestOutcome =
  | { status: "stored"; recordingId: string; matchedLeadRef: string | null }
  | { status: "skipped_duplicate"; recordingId: string }
  | { status: "rejected"; reason: string }
  | { status: "already_processed" };

export async function ingestRecording(
  deps: IngestDeps,
  file: IncomingFile,
): Promise<IngestOutcome> {
  const { db } = deps;
  const platform = await db
    .selectFrom("platforms")
    .select(["id", "code", "organisation_id"])
    .where("id", "=", file.platformId)
    .executeTakeFirstOrThrow();

  // 1. Ledger
  const job = await db
    .insertInto("transfer_jobs")
    .values({
      platform_id: file.platformId,
      mode: file.mode,
      remote_path: file.remotePath,
      remote_size: file.size,
      remote_mtime: file.mtime,
      status: "transferring",
    })
    .onConflict((oc) =>
      oc
        .columns(["platform_id", "remote_path", "remote_size", "remote_mtime"])
        .doUpdateSet({
          attempts: sql`transfer_jobs.attempts + 1`,
          status: "transferring",
          error_code: null,
        })
        .where("transfer_jobs.status", "in", ["failed", "transferring"]),
    )
    .returning("id")
    .executeTakeFirst();
  if (!job) return { status: "already_processed" };

  const finishJob = (
    status: "stored" | "rejected" | "failed" | "skipped_duplicate",
    extra: { recordingId?: string; errorCode?: string } = {},
  ) =>
    db
      .updateTable("transfer_jobs")
      .set({
        status,
        recording_id: extra.recordingId ?? null,
        error_code: extra.errorCode ?? null,
        finished_at: sql`now()`,
      })
      .where("id", "=", job.id)
      .execute();

  try {
    const oversized = file.size > deps.maxBytes || file.data.length > deps.maxBytes;
    // Oversized files are never read into memory; give them a distinct marker instead of a content hash.
    const sha256 = oversized
      ? createHash("sha256")
          .update(`oversized:${file.remotePath}:${file.size}:${file.mtime.toISOString()}`)
          .digest()
      : createHash("sha256").update(file.data).digest();
    const parsed = parseRecordingName(file.fileName);
    const retentionUntil = new Date(Date.now() + deps.retentionDays * 86_400_000);

    // 2. Validate
    let reason: string | null = null;
    if (!parsed) reason = "invalid_file_name_or_type";
    else if (oversized) reason = "file_too_large";
    else if (file.data.length === 0) reason = "empty_file";
    else if (detectAudio(file.data) !== parsed.ext) reason = "content_does_not_match_type";
    if (reason) {
      const rejected = await db
        .insertInto("consent_recordings")
        .values({
          organisation_id: platform.organisation_id,
          platform_id: platform.id,
          original_filename: file.fileName.slice(0, 200),
          recording_ref: (parsed?.stem ?? file.fileName).slice(0, 200),
          size_bytes: file.size,
          sha256,
          status: "rejected",
          rejection_reason: reason,
          retention_until: retentionUntil,
        })
        .onConflict((oc) => oc.columns(["platform_id", "sha256"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      await finishJob("rejected", {
        errorCode: reason,
        ...(rejected ? { recordingId: rejected.id } : {}),
      });
      return { status: "rejected", reason };
    }

    // 3. Dedupe by content
    const dup = await db
      .selectFrom("consent_recordings")
      .select(["id", "status"])
      .where("platform_id", "=", platform.id)
      .where("sha256", "=", sha256)
      .executeTakeFirst();
    if (dup && dup.status !== "rejected") {
      await finishJob("skipped_duplicate", { recordingId: dup.id });
      return { status: "skipped_duplicate", recordingId: dup.id };
    }

    // 4. Store (encrypted) and record
    const storageKey = newRecordingKey(platform.organisation_id, platform.id);
    await deps.store.put(storageKey, file.data);
    const rec = await db
      .insertInto("consent_recordings")
      .values({
        organisation_id: platform.organisation_id,
        platform_id: platform.id,
        original_filename: parsed!.fileName,
        recording_ref: parsed!.stem,
        storage_key: storageKey,
        content_type: RECORDING_EXTENSIONS[parsed!.ext],
        size_bytes: file.data.length,
        sha256,
        status: "unmatched",
        retention_until: retentionUntil,
      })
      .onConflict((oc) =>
        // A previously rejected copy of the same bytes is superseded by this valid upload.
        oc.columns(["platform_id", "sha256"]).doUpdateSet({
          status: "unmatched",
          rejection_reason: null,
          storage_key: storageKey,
          content_type: RECORDING_EXTENSIONS[parsed!.ext],
          original_filename: parsed!.fileName,
          recording_ref: parsed!.stem,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    // 5. Match
    const matched = await matchRecording(deps, rec, platform.code);
    await finishJob("stored", { recordingId: rec.id });
    return { status: "stored", recordingId: rec.id, matchedLeadRef: matched };
  } catch (err) {
    await finishJob("failed", { errorCode: "processing_error" });
    throw err;
  }
}

/** Tries to attach an unmatched recording to a lead of the same provider. Returns the lead ref or null. */
export async function matchRecording(
  deps: Pick<IngestDeps, "db" | "onMatched">,
  rec: Pick<ConsentRecording, "id" | "platform_id" | "recording_ref" | "original_filename">,
  platformCode: string,
): Promise<string | null> {
  const { db } = deps;
  const candidates = matchCandidates(rec.recording_ref, platformCode);
  for (const c of candidates) {
    const byRef =
      c.kind === "recording_ref"
        ? await db
            .selectFrom("leads")
            .select(["id", "lead_ref", "consent_status"])
            .where("platform_id", "=", rec.platform_id)
            .where("recording_ref", "=", c.value)
            .executeTakeFirst()
        : undefined;
    const byExternal =
      byRef ??
      (await db
        .selectFrom("leads")
        .select(["id", "lead_ref", "consent_status"])
        .where("platform_id", "=", rec.platform_id)
        .where("external_lead_id", "=", c.value)
        .executeTakeFirst());
    const lead = byRef ?? byExternal;
    if (!lead) continue;
    const matchedBy = byRef
      ? "recording_ref"
      : c.kind === "naming_convention"
        ? "naming_convention"
        : "external_lead_id";
    await attach(db, rec.id, lead, matchedBy, { type: "system" }, rec.original_filename);
    if (deps.onMatched) await deps.onMatched(lead.id);
    return lead.lead_ref;
  }
  return null;
}

async function attach(
  db: Kysely<Database>,
  recordingId: string,
  lead: { id: string; consent_status: string },
  matchedBy: "recording_ref" | "naming_convention" | "external_lead_id" | "admin",
  actor: { type: "system" | "admin"; id?: string | null },
  fileName: string,
) {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("consent_recordings")
      .set({ lead_id: lead.id, status: "matched", matched_by: matchedBy, matched_at: sql`now()` })
      .where("id", "=", recordingId)
      .execute();
    if (lead.consent_status !== "matched") {
      await trx
        .updateTable("leads")
        .set({ consent_status: "matched" })
        .where("id", "=", lead.id)
        .execute();
    }
    await trx
      .insertInto("lead_events")
      .values({
        lead_id: lead.id,
        type: "consent_recording_matched",
        from_status: null,
        to_status: null,
        actor_type: actor.type,
        actor_id: actor.id ?? null,
        detail: JSON.stringify({
          recording_id: recordingId,
          file: fileName,
          matched_by: matchedBy,
          consent_status_was: lead.consent_status,
        }),
      })
      .execute();
  });
}

export class RecordingLinkError extends Error {}

/** Operator links an unmatched recording to a lead of the same provider. Audited. */
export async function linkRecording(
  deps: Pick<IngestDeps, "db" | "onMatched">,
  recordingId: string,
  leadRef: string,
  actor: Actor,
): Promise<void> {
  const { db } = deps;
  const rec = await db
    .selectFrom("consent_recordings")
    .selectAll()
    .where("id", "=", recordingId)
    .executeTakeFirst();
  if (!rec) throw new RecordingLinkError("recording not found");
  if (rec.status !== "unmatched")
    throw new RecordingLinkError(
      `only unmatched recordings can be linked (status is ${rec.status})`,
    );
  const lead = await db
    .selectFrom("leads")
    .select(["id", "lead_ref", "consent_status", "platform_id", "organisation_id"])
    .where("lead_ref", "=", leadRef)
    .executeTakeFirst();
  if (!lead) throw new RecordingLinkError("lead not found");
  if (lead.platform_id !== rec.platform_id)
    throw new RecordingLinkError("the lead belongs to a different provider");
  await attach(
    db,
    rec.id,
    lead,
    "admin",
    { type: "admin", id: actor.id ?? null },
    rec.original_filename,
  );
  await writeAudit(db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    organisationId: lead.organisation_id,
    action: "recording.linked",
    targetType: "recording",
    targetId: rec.id,
    requestId: actor.requestId ?? null,
    ip: actor.ip ?? null,
    detail: { lead_ref: lead.lead_ref, file: rec.original_filename },
  });
  if (deps.onMatched) await deps.onMatched(lead.id);
}

export interface MaintenanceResult {
  rematched: number;
  overdue: number;
}

/** Re-tries matching for unmatched recordings (the lead may have arrived later) and flags overdue consent. */
export async function runRecordingMaintenance(
  deps: Pick<IngestDeps, "db" | "onMatched">,
  overdueHours: number,
): Promise<MaintenanceResult> {
  const { db } = deps;
  const unmatched = await db
    .selectFrom("consent_recordings as r")
    .innerJoin("platforms as p", "p.id", "r.platform_id")
    .select(["r.id", "r.platform_id", "r.recording_ref", "r.original_filename", "p.code"])
    .where("r.status", "=", "unmatched")
    .orderBy("r.created_at")
    .limit(500)
    .execute();
  let rematched = 0;
  for (const r of unmatched) if (await matchRecording(deps, r, r.code)) rematched++;

  const overdue = await db
    .updateTable("leads")
    .set({ consent_status: "overdue" })
    .where("consent_status", "=", "awaiting_recording")
    .where("received_at", "<", sql<Date>`now() - make_interval(hours => ${overdueHours})`)
    .returning("id")
    .execute();
  if (overdue.length) {
    await db
      .insertInto("lead_events")
      .values(
        overdue.map((l) => ({
          lead_id: l.id,
          type: "consent_recording_overdue",
          actor_type: "system" as const,
          detail: JSON.stringify({ after_hours: overdueHours }),
        })),
      )
      .execute();
  }
  return { rematched, overdue: overdue.length };
}

/** Deletes recording content past its retention date (metadata kept as status "deleted"). Audited. */
export async function purgeExpiredRecordings(
  deps: Pick<IngestDeps, "db" | "store">,
): Promise<number> {
  const { db, store } = deps;
  const expired = await db
    .selectFrom("consent_recordings")
    .select(["id", "storage_key", "organisation_id"])
    .where("retention_until", "<", sql<Date>`now()`)
    .where("status", "!=", "deleted")
    .limit(1000)
    .execute();
  for (const r of expired) {
    if (r.storage_key) await store.delete(r.storage_key);
    await db
      .updateTable("consent_recordings")
      .set({ status: "deleted", storage_key: null })
      .where("id", "=", r.id)
      .execute();
  }
  if (expired.length) {
    await writeAudit(db, {
      actorType: "system",
      actorLabel: "retention-purge",
      action: "recording.purged",
      targetType: "recording",
      detail: { count: expired.length },
    });
  }
  return expired.length;
}
