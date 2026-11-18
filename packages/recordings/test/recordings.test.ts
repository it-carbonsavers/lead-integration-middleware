import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganisation, createPlatform, leadRowFromSubmission, type Actor } from "@lim/db";
import { newLeadRef, normaliseLeadSubmission } from "@lim/core";
import {
  detectAudio,
  ingestRecording,
  linkRecording,
  LocalEncryptedStore,
  makeTestWav,
  matchCandidates,
  parseRecordingName,
  purgeExpiredRecordings,
  RecordingLinkError,
  runRecordingMaintenance,
  scanHostedUploads,
  type IngestDeps,
} from "../src/index.js";
import { createTestDatabase, type TestDatabase } from "../../../test/helpers.js";
import { MemoryInbox } from "../../../test/memory-inbox.js";

const actor: Actor = { type: "system", label: "test" };
let t: TestDatabase;
let deps: IngestDeps;
let storeDir: string;
let orgId: string;
let p1: { id: string; code: string };
let p2: { id: string; code: string };
const matchedLeads: string[] = [];
let seq = 0;

async function addLead(
  platformId: string,
  externalId: string,
  recordingRef?: string,
  verbal = true,
) {
  const r = normaliseLeadSubmission(
    {
      schema_version: "1",
      external_lead_id: externalId,
      transferred_at: new Date(Date.now() - 60_000).toISOString(),
      customer: { first_name: "Alex", last_name: "Example", phone: "0491 570 006" },
      agent: { external_id: "AG-1" },
      consent: { verbal_consent: verbal, ...(recordingRef ? { recording_ref: recordingRef } : {}) },
    },
    { defaultPhoneRegion: "AU" },
  );
  if (!r.ok) throw new Error("bad lead");
  const row = leadRowFromSubmission(
    r.lead,
    {
      leadRef: newLeadRef(),
      organisationId: orgId,
      platformId,
      agentId: null,
      retentionUntil: new Date(Date.now() + 86_400_000),
      destinationId: null,
    },
    { encryptionKey: t.config.APP_ENCRYPTION_KEY, blindIndexKey: t.config.APP_BLIND_INDEX_KEY },
  );
  return t.db
    .insertInto("leads")
    .values(row)
    .returning(["id", "lead_ref"])
    .executeTakeFirstOrThrow();
}

const file = (
  platformId: string,
  fileName: string,
  data: Buffer,
  over: Partial<{ size: number; mtime: Date; remotePath: string }> = {},
) => ({
  platformId,
  mode: "sftp_hosted" as const,
  remotePath: over.remotePath ?? fileName,
  fileName,
  size: over.size ?? data.length,
  mtime: over.mtime ?? new Date(1_700_000_000_000 + ++seq * 1000),
  data,
});

beforeAll(async () => {
  t = await createTestDatabase();
  storeDir = await mkdtemp(join(tmpdir(), "lim-store-"));
  deps = {
    db: t.db,
    store: new LocalEncryptedStore(storeDir, t.config.APP_ENCRYPTION_KEY),
    maxBytes: 100_000,
    retentionDays: 30,
    onMatched: async (leadId) => void matchedLeads.push(leadId),
  };
  orgId = (await createOrganisation(t.db, { name: "Org", slug: "org" }, actor)).id;
  p1 = await createPlatform(
    t.db,
    { organisationId: orgId, code: "PRV01", displayName: "P1" },
    actor,
  );
  p2 = await createPlatform(
    t.db,
    { organisationId: orgId, code: "PRV02", displayName: "P2" },
    actor,
  );
});

afterAll(async () => {
  await t?.destroy();
});

describe("file rules", () => {
  it("accepts safe names with allowed extensions only", () => {
    expect(parseRecordingName("TRX-1.wav")).toMatchObject({ stem: "TRX-1", ext: "wav" });
    expect(parseRecordingName("PRV01_TRX-1_20261117T094002Z.MP3")).toMatchObject({ ext: "mp3" });
    for (const bad of [
      "../etc/passwd.wav",
      "a/b.wav",
      "x.exe",
      ".hidden.wav",
      "noext",
      "x..wav",
      "a b.wav",
    ]) {
      expect(parseRecordingName(bad)).toBeNull();
    }
  });

  it("detects real audio content", () => {
    expect(detectAudio(makeTestWav(0.1))).toBe("wav");
    expect(
      detectAudio(Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000")),
    ).toBe("mp3");
    expect(detectAudio(Buffer.from("<html><body>not audio</body></html>"))).toBeNull();
  });

  it("derives match candidates from the naming convention", () => {
    expect(matchCandidates("PRV01_TRX_1_20261117T094002Z", "PRV01")).toEqual([
      { kind: "recording_ref", value: "PRV01_TRX_1_20261117T094002Z" },
      { kind: "naming_convention", value: "TRX_1" },
    ]);
  });
});

describe("encrypted storage", () => {
  it("never writes audio in clear and refuses unsafe keys", async () => {
    const s = new LocalEncryptedStore(storeDir, t.config.APP_ENCRYPTION_KEY);
    const wav = makeTestWav(0.1);
    await s.put("recordings/test/one.bin", wav);
    const raw = await readFile(join(storeDir, "recordings/test/one.bin"));
    expect(raw.includes(Buffer.from("RIFF"))).toBe(false);
    expect((await s.get("recordings/test/one.bin")).equals(wav)).toBe(true);
    await expect(s.put("../escape.bin", wav)).rejects.toThrow();
    await expect(s.get("recordings/../../x.bin")).rejects.toThrow();
  });
});

describe("ingest and matching", () => {
  it("stores, matches by recording_ref, updates consent and records the transfer", async () => {
    const lead = await addLead(p1.id, "EXT-1", "REC-1");
    const out = await ingestRecording(deps, file(p1.id, "REC-1.wav", makeTestWav(0.2)));
    expect(out).toMatchObject({ status: "stored", matchedLeadRef: lead.lead_ref });
    const l = await t.db
      .selectFrom("leads")
      .select("consent_status")
      .where("id", "=", lead.id)
      .executeTakeFirstOrThrow();
    expect(l.consent_status).toBe("matched");
    const rec = await t.db
      .selectFrom("consent_recordings")
      .selectAll()
      .where("lead_id", "=", lead.id)
      .executeTakeFirstOrThrow();
    expect(rec).toMatchObject({
      status: "matched",
      matched_by: "recording_ref",
      content_type: "audio/wav",
    });
    expect(rec.storage_key).toMatch(/^recordings\//);
    expect(rec.storage_key).not.toContain("REC-1");
    const job = await t.db
      .selectFrom("transfer_jobs")
      .selectAll()
      .where("recording_id", "=", rec.id)
      .executeTakeFirstOrThrow();
    expect(job.status).toBe("stored");
    const events = await t.db
      .selectFrom("lead_events")
      .select("type")
      .where("lead_id", "=", lead.id)
      .execute();
    expect(events.map((e) => e.type)).toContain("consent_recording_matched");
    expect(matchedLeads).toContain(lead.id);
  });

  it("matches by naming convention and by plain external id", async () => {
    const a = await addLead(p1.id, "EXT-NC-1");
    const b = await addLead(p1.id, "EXT-PLAIN-1");
    expect(
      await ingestRecording(
        deps,
        file(p1.id, "PRV01_EXT-NC-1_20261117T094002Z.wav", makeTestWav(0.2, 300)),
      ),
    ).toMatchObject({
      matchedLeadRef: a.lead_ref,
    });
    expect(
      await ingestRecording(deps, file(p1.id, "EXT-PLAIN-1.wav", makeTestWav(0.2, 310))),
    ).toMatchObject({
      matchedLeadRef: b.lead_ref,
    });
  });

  it("never matches another provider's lead", async () => {
    await addLead(p2.id, "EXT-OTHER", "REC-OTHER");
    const out = await ingestRecording(deps, file(p1.id, "REC-OTHER.wav", makeTestWav(0.2, 320)));
    expect(out).toMatchObject({ status: "stored", matchedLeadRef: null });
  });

  it("skips the same content twice and the same remote file twice", async () => {
    const wav = makeTestWav(0.2, 330);
    const first = await ingestRecording(deps, file(p1.id, "DUP-1.wav", wav));
    const second = await ingestRecording(deps, file(p1.id, "DUP-1-copy.wav", wav));
    expect(second).toMatchObject({
      status: "skipped_duplicate",
      recordingId: (first as { recordingId: string }).recordingId,
    });
    const f = file(p1.id, "SAME-PATH.wav", makeTestWav(0.2, 340));
    await ingestRecording(deps, f);
    expect(await ingestRecording(deps, f)).toEqual({ status: "already_processed" });
  });

  it("rejects disguised files, bad names, empty and oversized files (without reading oversized ones)", async () => {
    expect(
      await ingestRecording(
        deps,
        file(p1.id, "fake.wav", Buffer.from("<script>alert(1)</script> padding padding")),
      ),
    ).toEqual({
      status: "rejected",
      reason: "content_does_not_match_type",
    });
    expect(await ingestRecording(deps, file(p1.id, "evil.exe", makeTestWav(0.1, 350)))).toEqual({
      status: "rejected",
      reason: "invalid_file_name_or_type",
    });
    expect(
      await ingestRecording(deps, file(p1.id, "big.wav", Buffer.alloc(0), { size: 200_000 })),
    ).toEqual({ status: "rejected", reason: "file_too_large" });
    const rejected = await t.db
      .selectFrom("consent_recordings")
      .select(["status", "storage_key"])
      .where("status", "=", "rejected")
      .execute();
    expect(rejected.length).toBeGreaterThanOrEqual(3);
    expect(rejected.every((r) => r.storage_key === null)).toBe(true);
  });

  it("re-matches when the lead arrives after the recording, and marks overdue consent", async () => {
    const out = await ingestRecording(deps, file(p1.id, "LATE-REF.wav", makeTestWav(0.2, 360)));
    expect(out).toMatchObject({ matchedLeadRef: null });
    const lead = await addLead(p1.id, "EXT-LATE", "LATE-REF");
    const stale = await addLead(p1.id, "EXT-STALE", "NEVER-ARRIVES");
    await sql`UPDATE leads SET received_at = now() - interval '72 hours' WHERE id = ${stale.id}`.execute(
      t.db,
    );
    const res = await runRecordingMaintenance(deps, 48);
    expect(res.rematched).toBeGreaterThanOrEqual(1);
    expect(res.overdue).toBeGreaterThanOrEqual(1);
    const rows = await t.db
      .selectFrom("leads")
      .select(["id", "consent_status"])
      .where("id", "in", [lead.id, stale.id])
      .execute();
    expect(Object.fromEntries(rows.map((r) => [r.id, r.consent_status]))).toEqual({
      [lead.id]: "matched",
      [stale.id]: "overdue",
    });
  });

  it("lets an operator link an unmatched recording, but only to the same provider's lead", async () => {
    const out = (await ingestRecording(deps, file(p1.id, "ORPHAN.wav", makeTestWav(0.2, 370)))) as {
      recordingId: string;
    };
    const otherLead = await addLead(p2.id, "EXT-P2-LINK");
    await expect(
      linkRecording(deps, out.recordingId, otherLead.lead_ref, actor),
    ).rejects.toBeInstanceOf(RecordingLinkError);
    const lead = await addLead(p1.id, "EXT-P1-LINK");
    await linkRecording(deps, out.recordingId, lead.lead_ref, { type: "admin", label: "ops@test" });
    const rec = await t.db
      .selectFrom("consent_recordings")
      .select(["status", "matched_by"])
      .where("id", "=", out.recordingId)
      .executeTakeFirstOrThrow();
    expect(rec).toEqual({ status: "matched", matched_by: "admin" });
    const audit = await t.db
      .selectFrom("audit_log")
      .select("action")
      .where("target_id", "=", out.recordingId)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(["recording.linked"]);
  });

  it("purges content past retention and keeps the metadata", async () => {
    const out = (await ingestRecording(deps, file(p1.id, "OLD.wav", makeTestWav(0.2, 380)))) as {
      recordingId: string;
    };
    const before = await t.db
      .selectFrom("consent_recordings")
      .select("storage_key")
      .where("id", "=", out.recordingId)
      .executeTakeFirstOrThrow();
    await t.db
      .updateTable("consent_recordings")
      .set({ retention_until: sql<Date>`now() - interval '1 day'` })
      .where("id", "=", out.recordingId)
      .execute();
    expect(await purgeExpiredRecordings(deps)).toBe(1);
    const after = await t.db
      .selectFrom("consent_recordings")
      .select(["status", "storage_key"])
      .where("id", "=", out.recordingId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ status: "deleted", storage_key: null });
    await expect(deps.store.get(before.storage_key!)).rejects.toThrow();
  });
});

describe("uploads to our SFTP server", () => {
  it("processes complete uploads, ignores partial ones, and clears the upload area", async () => {
    await t.db
      .insertInto("platform_sftp_configs")
      .values({
        platform_id: p2.id,
        mode: "sftp_hosted",
        username: "prv02",
        authorized_keys: ["ssh-ed25519 AAAA test"],
      })
      .execute();
    const lead = await addLead(p2.id, "EXT-HOSTED", "HOSTED-1");
    const inbox = new MemoryInbox();
    inbox.add("prv02", "HOSTED-1.wav", makeTestWav(0.2, 390), new Date(Date.now() - 1000));
    inbox.add("prv02", "IN-PROGRESS.wav.part", makeTestWav(0.2, 391));
    inbox.add("prv02", "BIG.wav.filepart", makeTestWav(0.2, 392));
    const [summary] = await scanHostedUploads(deps, inbox);
    expect(summary).toMatchObject({ platform: "PRV02", seen: 1, stored: 1 });
    expect(inbox.names("prv02").sort()).toEqual(["BIG.wav.filepart", "IN-PROGRESS.wav.part"]);
    const l = await t.db
      .selectFrom("leads")
      .select("consent_status")
      .where("id", "=", lead.id)
      .executeTakeFirstOrThrow();
    expect(l.consent_status).toBe("matched");
  });
});
