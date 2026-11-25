/**
 * GET /system: operational status for administrators (internal staff with platforms.manage).
 * GET /integration: the API address and documentation links to give lead providers.
 * Everything an operator needs to see at a glance: services up, queues, things needing attention.
 */

import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { publicApiUrl } from "@lim/config";
import { QUEUES, DEAD_LETTER_QUEUE } from "@lim/core";
import { isSchemaCurrent, pingDb } from "@lim/db";
import { requirePermission } from "../auth.js";
import type { AdminRouteOptions } from "./index.js";

const WORKER_STALE_SECONDS = 150;

export async function adminSystemRoutes(app: FastifyInstance, opts: AdminRouteOptions) {
  const { db, config, boss } = opts;

  app.get(
    "/integration",
    { preHandler: requirePermission("platforms.manage", { internalOnly: true }) },
    async () => {
      const base = publicApiUrl(config);
      return {
        api_base_url: base,
        lead_endpoint: base ? `${base}/v1/leads` : null,
        openapi_url: base ? `${base}/openapi.json` : null,
      };
    },
  );

  app.get(
    "/system",
    { preHandler: requirePermission("platforms.manage", { internalOnly: true }) },
    async () => {
      const database = await pingDb(db);
      const migrations = database && (await isSchemaCurrent(db));
      const status = await db.selectFrom("service_status").selectAll().execute();
      const byName = Object.fromEntries(status.map((s) => [s.name, s]));
      const worker = byName["worker"];
      const workerAge = worker ? (Date.now() - worker.last_seen_at.getTime()) / 1000 : null;

      const queueNames = [
        QUEUES.deliverLead.name,
        QUEUES.syncConsent.name,
        QUEUES.recordingsScan.name,
        DEAD_LETTER_QUEUE,
      ];
      const queues = (await boss.getQueues(queueNames)).map((q) => ({
        name: q.name,
        queued: q.queuedCount,
        active: q.activeCount,
        deferred: q.deferredCount,
        failed: q.failedCount,
        total: q.totalCount,
      }));

      const [attention] = await db
        .selectFrom("leads")
        .select([
          sql<number>`count(*) FILTER (WHERE status = 'failed')::int`.as("failed"),
          sql<number>`count(*) FILTER (WHERE status = 'dead_letter')::int`.as("dead_letter"),
          sql<number>`count(*) FILTER (WHERE status = 'retry_scheduled')::int`.as("retrying"),
          sql<number>`count(*) FILTER (WHERE status IN ('queued','delivering'))::int`.as(
            "in_flight",
          ),
          sql<number>`count(*) FILTER (WHERE consent_status = 'overdue')::int`.as(
            "consent_overdue",
          ),
          sql<number>`count(*) FILTER (WHERE anonymised_at IS NOT NULL)::int`.as("anonymised"),
        ])
        .execute();
      const [recs] = await db
        .selectFrom("consent_recordings")
        .select([
          sql<number>`count(*) FILTER (WHERE status = 'unmatched')::int`.as("unmatched"),
          sql<number>`count(*) FILTER (WHERE status = 'rejected' AND created_at > now() - interval '7 days')::int`.as(
            "rejected_7d",
          ),
        ])
        .execute();
      const [subs] = await db
        .selectFrom("submissions")
        .select(
          sql<number>`count(*) FILTER (WHERE outcome = 'rejected' AND received_at > now() - interval '24 hours')::int`.as(
            "rejected_24h",
          ),
        )
        .execute();

      return {
        environment: config.APP_ENV,
        checked_at: new Date().toISOString(),
        services: {
          api: { ok: true },
          database: { ok: database, migrations_current: migrations },
          worker: {
            ok: workerAge !== null && workerAge < WORKER_STALE_SECONDS,
            last_seen_at: worker?.last_seen_at ?? null,
          },
          hubspot: { enabled: config.HUBSPOT_ENABLED },
          recording_storage: {
            configured:
              config.RECORDING_STORE === "s3"
                ? Boolean(config.RECORDINGS_BUCKET)
                : Boolean(config.RECORDING_STORAGE_DIR),
            kind: config.RECORDING_STORE,
          },
          sftp: {
            configured: Boolean(config.SFTPGO_API_URL),
            host: config.SFTP_PUBLIC_HOST ?? null,
            port: config.SFTP_PUBLIC_PORT ?? null,
          },
        },
        queues,
        attention: { ...attention, ...recs, rejected_submissions_24h: subs?.rejected_24h ?? 0 },
        last_recordings_scan: byName["recordings-scan"] ?? null,
        last_retention_run: byName["retention-purge"] ?? null,
      };
    },
  );
}
