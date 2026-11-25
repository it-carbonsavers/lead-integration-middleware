/**
 * Worker service entry point (no inbound HTTP).
 *
 * Boots pg-boss, creates the queues and their retry/dead-letter policies, and runs:
 *   deliver-lead (Destination Integration Layer), recordings-scan (uploads to our SFTP server),
 *   recordings-maintenance, sync-consent, retention-purge, sync-outcomes (every 15 minutes,
 *   read-only, off unless OUTCOME_SYNC_ENABLED) and a one-minute heartbeat.
 */

import pino from "pino";
import { ConfigError, loadConfig, loggerOptions } from "@lim/config";
import { QUEUES } from "@lim/core";
import { createDb, touchServiceStatus } from "@lim/db";
import { createBoss, ensureQueues, type DeliverLeadJob } from "@lim/jobs";
import { prepareObjectStorage, recordingStore, sftpRuntime } from "@lim/recordings";
import { deliverLead } from "./handlers/deliver-lead.js";
import { runOutcomeSync } from "./handlers/outcomes.js";
import {
  runMaintenance,
  runRecordingsScan,
  runRetentionPurge,
  syncConsent,
} from "./handlers/recordings.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino(loggerOptions(config, "lim-worker"));
  const db = createDb(config);
  const boss = createBoss(config);

  boss.on("error", (err) => log.error({ err }, "pg-boss error"));

  await boss.start();
  await ensureQueues(boss, config);
  await touchServiceStatus(db, "worker", {
    hubspot_enabled: config.HUBSPOT_ENABLED,
    started: true,
  });

  await boss.schedule(QUEUES.heartbeat.name, "* * * * *", null, { tz: "UTC" });

  // --- Consent recordings ---------------------------------------------------------
  // Storage is checked once at start-up (locally, missing buckets are created). A failure is
  // logged and shows on System health; scans report "storage_unavailable" until it recovers.
  await prepareObjectStorage(config).catch((err: unknown) =>
    log.error({ err: err instanceof Error ? err.message : err }, "object storage not ready"),
  );
  const store = recordingStore(config);
  const rec = {
    db,
    config,
    log,
    boss,
    ...(store ? { store } : {}),
    inbox: sftpRuntime(config).inbox,
  };
  await boss.schedule(QUEUES.recordingsScan.name, "* * * * *", null, { tz: "UTC" });
  await boss.schedule(QUEUES.recordingsMaintenance.name, "* * * * *", null, { tz: "UTC" });
  await boss.schedule(QUEUES.retentionPurge.name, "15 3 * * *", null, {
    tz: config.REPORT_TIMEZONE,
  });
  await boss.work<{ platformId?: string } | null>(
    QUEUES.recordingsScan.name,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const j of jobs) await runRecordingsScan(rec, j.data?.platformId);
    },
  );
  await boss.work(
    QUEUES.recordingsMaintenance.name,
    { batchSize: 1, localConcurrency: 1 },
    async () => {
      await runMaintenance(rec);
    },
  );
  await boss.work(QUEUES.retentionPurge.name, { batchSize: 1, localConcurrency: 1 }, async () => {
    await runRetentionPurge(rec);
  });
  await boss.work<{ leadId: string }>(
    QUEUES.syncConsent.name,
    { batchSize: 1, localConcurrency: 2 },
    async (jobs) => {
      for (const j of jobs) await syncConsent(rec, j.data.leadId);
    },
  );
  // --- Lead outcomes (read-only from HubSpot) --------------------------------------
  if (config.OUTCOME_SYNC_ENABLED) {
    await boss.schedule(QUEUES.syncOutcomes.name, "*/15 * * * *", null, { tz: "UTC" });
  } else {
    await boss.unschedule(QUEUES.syncOutcomes.name);
  }
  await boss.work(QUEUES.syncOutcomes.name, { batchSize: 1, localConcurrency: 1 }, async () => {
    await runOutcomeSync({ db, config, log });
  });

  await boss.work(QUEUES.heartbeat.name, async (jobs) => {
    log.info({ jobs: jobs.length }, "worker heartbeat");
    await touchServiceStatus(db, "worker", { hubspot_enabled: config.HUBSPOT_ENABLED });
  });

  // Deliveries are fetched in batches and settled per job: a failure retries only that lead.
  // While batches come back full the worker keeps fetching without waiting (backlog catch-up),
  // and new leads wake it immediately via LISTEN/NOTIFY.
  await boss.work<DeliverLeadJob>(
    QUEUES.deliverLead.name,
    {
      batchSize: config.DELIVERY_BATCH_SIZE,
      localConcurrency: config.DELIVERY_CONCURRENCY,
      perJobResults: true,
      burstWhenBatchFull: true,
      pollingIntervalSeconds: 1,
      // New jobs wake the worker via NOTIFY, but retries do not: poll often enough that a
      // retry runs close to its scheduled time.
      notifyPollingIntervalSeconds: 5,
    },
    async (jobs) =>
      Promise.all(
        jobs.map(async (job) => {
          try {
            await deliverLead({ db, config, log }, job);
            return { id: job.id, status: "completed" as const };
          } catch (err) {
            // Retryable failure: pg-boss schedules the retry (or dead-letters when exhausted).
            const code =
              err instanceof Error && "code" in err
                ? String((err as { code: unknown }).code)
                : "error";
            return { id: job.id, status: "failed" as const, output: { code } };
          }
        }),
      ),
  );

  log.info(
    {
      hubspotEnabled: config.HUBSPOT_ENABLED,
      outcomeSync: config.OUTCOME_SYNC_ENABLED,
      concurrency: config.DELIVERY_CONCURRENCY,
    },
    "worker started",
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "worker stopping (waiting for active jobs)");
    try {
      await boss.stop({ graceful: true, timeout: 25_000 });
      await db.destroy();
      process.exit(0);
    } catch (err) {
      log.error({ err }, "error during worker shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error("Worker failed to start:", err);
  process.exit(1);
});
