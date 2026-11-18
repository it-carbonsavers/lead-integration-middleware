/**
 * Consent recording jobs.
 *   recordings-scan         pick up uploads from our SFTP server's storage (every minute, or on demand)
 *   recordings-maintenance  re-match unmatched recordings, mark overdue consent (every minute)
 *   sync-consent            push a lead's new consent status to its destination
 *   retention-purge         delete recording content past its retention date (daily)
 */

import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { Env } from "@lim/config";
import { DestinationError, QUEUES } from "@lim/core";
import {
  anonymiseExpiredLeads,
  purgeOldPayloads,
  touchServiceStatus,
  type Database,
} from "@lim/db";
import { createAdapter, type AdapterDeps } from "@lim/destinations";
import type { PgBoss } from "@lim/jobs";
import {
  purgeExpiredRecordings,
  recordingStore,
  runRecordingMaintenance,
  scanHostedUploads,
  sftpRuntime,
  type IngestDeps,
  type ObjectStore,
  type UploadInbox,
} from "@lim/recordings";

export interface RecordingJobDeps {
  db: Kysely<Database>;
  config: Env;
  log: Logger;
  boss: PgBoss;
  store?: ObjectStore;
  inbox?: UploadInbox | null;
  adapterDeps?: Partial<AdapterDeps>;
}

export function storeFor(config: Env): ObjectStore | null {
  return recordingStore(config);
}

function ingestDeps(deps: RecordingJobDeps, store: ObjectStore): IngestDeps {
  return {
    db: deps.db,
    store,
    maxBytes: deps.config.RECORDING_MAX_MB * 1024 * 1024,
    retentionDays: deps.config.RECORDING_RETENTION_DAYS,
    onMatched: async (leadId) => {
      await deps.boss.send(QUEUES.syncConsent.name, { leadId });
    },
  };
}

export async function runRecordingsScan(deps: RecordingJobDeps, platformId?: string) {
  const store = deps.store ?? storeFor(deps.config);
  if (!store) {
    deps.log.warn("recording storage not configured: recording scan skipped");
    return [];
  }
  const ing = ingestDeps(deps, store);
  const inbox = deps.inbox !== undefined ? deps.inbox : sftpRuntime(deps.config).inbox;
  const results = inbox
    ? await scanHostedUploads(ing, inbox, platformId ? { platformId } : {})
    : [];
  for (const r of results) {
    if (r.seen || r.error) deps.log.info(r, "recordings scan");
  }
  await touchServiceStatus(deps.db, "recordings-scan", { results });
  return results;
}

export async function runMaintenance(deps: RecordingJobDeps) {
  const result = await runRecordingMaintenance(
    {
      db: deps.db,
      onMatched: async (leadId) => void (await deps.boss.send(QUEUES.syncConsent.name, { leadId })),
    },
    deps.config.CONSENT_OVERDUE_HOURS,
  );
  if (result.rematched || result.overdue) deps.log.info(result, "recordings maintenance");
  return result;
}

/** Daily retention: recordings content, lead personal data, raw submission payloads. */
export async function runRetentionPurge(deps: RecordingJobDeps) {
  const store = deps.store ?? storeFor(deps.config);
  const recordings = store ? await purgeExpiredRecordings({ db: deps.db, store }) : 0;
  const leads = await anonymiseExpiredLeads(deps.db, deps.config.APP_ENCRYPTION_KEY);
  const payloads = await purgeOldPayloads(deps.db, deps.config.PAYLOAD_RETENTION_DAYS);
  const result = { recordings, leads, payloads };
  if (recordings || leads || payloads) deps.log.info(result, "retention purge");
  await touchServiceStatus(deps.db, "retention-purge", result);
  return result;
}

/** Updates consent status at the destination for a delivered lead. Undelivered leads carry it on delivery. */
export async function syncConsent(
  deps: RecordingJobDeps,
  leadId: string,
): Promise<"synced" | "not_delivered" | "unsupported"> {
  const lead = await deps.db
    .selectFrom("leads")
    .select(["id", "lead_ref", "status", "consent_status", "destination_id", "destination_ids"])
    .where("id", "=", leadId)
    .executeTakeFirst();
  if (!lead || lead.status !== "delivered" || !lead.destination_id) return "not_delivered";
  const destination = await deps.db
    .selectFrom("destinations")
    .selectAll()
    .where("id", "=", lead.destination_id)
    .executeTakeFirstOrThrow();
  const adapter = createAdapter(destination, {
    db: deps.db,
    config: deps.config,
    ...deps.adapterDeps,
  });
  if (!adapter.updateConsent) return "unsupported";
  try {
    await adapter.updateConsent(
      lead.lead_ref,
      lead.consent_status,
      lead.destination_ids as Record<string, string>,
    );
  } catch (err) {
    if (err instanceof DestinationError && err.errorClass === "permanent") {
      deps.log.warn(
        { leadRef: lead.lead_ref, code: err.code },
        "consent status sync failed permanently",
      );
      return "unsupported";
    }
    throw err;
  }
  await deps.db
    .insertInto("lead_events")
    .values({
      lead_id: lead.id,
      type: "consent_status_synced",
      actor_type: "system",
      detail: JSON.stringify({
        consent_status: lead.consent_status,
        destination_type: destination.type,
      }),
    })
    .execute();
  return "synced";
}
