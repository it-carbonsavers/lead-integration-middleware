/**
 * pg-boss setup: durable jobs stored in the same PostgreSQL database (schema "pgboss").
 * Jobs survive restarts and deploys, are retried with back-off, and land in the
 * dead-letter queue when retries are exhausted.
 */

import { fromKysely, PgBoss } from "pg-boss";
import type { Transaction } from "kysely";
import type { Env } from "@lim/config";
import { ALL_QUEUES, QUEUES } from "@lim/core";

export const BOSS_SCHEMA = "pgboss";

export interface BossOptions {
  poolMax?: number;
  /** Producer-only instances (the API) do not run maintenance or cron scheduling. */
  role?: "worker" | "producer";
}

export function createBoss(
  config: Pick<Env, "DATABASE_URL" | "DATABASE_SSL">,
  { poolMax = 5, role = "worker" }: BossOptions = {},
): PgBoss {
  return new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: BOSS_SCHEMA,
    max: poolMax,
    application_name: role === "worker" ? "lead-integration-worker" : "lead-integration-api",
    ...(role === "producer" ? { supervise: false, schedule: false } : { useListenNotify: true }),
    ...(config.DATABASE_SSL === "disable"
      ? {}
      : { ssl: { rejectUnauthorized: config.DATABASE_SSL === "require" } }),
  });
}

export type DeliveryRetryConfig = Pick<
  Env,
  "DELIVERY_RETRY_LIMIT" | "DELIVERY_RETRY_DELAY_SECONDS" | "DELIVERY_RETRY_DELAY_MAX_SECONDS"
>;

/**
 * Creates every queue defined in @lim/core, or brings its retry policy up to date.
 * The deliver-lead retry policy can be overridden from configuration (short delays for local demos).
 */
export async function ensureQueues(boss: PgBoss, retry?: DeliveryRetryConfig): Promise<void> {
  for (const q of ALL_QUEUES) {
    const { name, ...base } = q;
    const options =
      retry && name === QUEUES.deliverLead.name
        ? {
            ...base,
            retryLimit: retry.DELIVERY_RETRY_LIMIT,
            retryDelay: retry.DELIVERY_RETRY_DELAY_SECONDS,
            retryDelayMax: retry.DELIVERY_RETRY_DELAY_MAX_SECONDS,
          }
        : base;
    const existing = await boss.getQueue(name);
    if (existing) await boss.updateQueue(name, options);
    else await boss.createQueue(name, options);
  }
}

export interface DeliverLeadJob {
  leadId: string;
}

/**
 * Enqueues delivery of a lead inside the caller's database transaction, so a lead is never
 * stored without its delivery job (or queued without being stored).
 */
export async function enqueueDelivery(
  boss: PgBoss,
  trx: Transaction<never> | Transaction<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  job: DeliverLeadJob,
): Promise<string | null> {
  return boss.send(QUEUES.deliverLead.name, job, { db: fromKysely(trx) });
}
