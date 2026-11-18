/**
 * Background job queues (pg-boss). Names and retry policies live here so the API (producer)
 * and the worker (consumer) agree. Handlers arrive in later phases:
 *   deliver-lead          P3  send a lead to its destination
 *   recordings-scan       pick up consent recordings (SFTP Option A folders, Option B pulls)
 *   recordings-maintenance re-match unmatched recordings, mark overdue consent
 *   sync-consent          update consent status at the destination
 *   retention-purge       delete expired recordings
 */

export interface QueueDefinition {
  name: string;
  /** Attempts after the first failure before the job is dead-lettered. */
  retryLimit: number;
  /** First retry delay in seconds; grows exponentially (with jitter) when retryBackoff is true. */
  retryDelay: number;
  retryBackoff: boolean;
  /** Upper bound for a single backed-off delay, in seconds. */
  retryDelayMax?: number;
  /** Seconds a single attempt may run before it is considered failed. */
  expireInSeconds: number;
  deadLetter?: string;
  /** Wake workers immediately when a job is added (Postgres LISTEN/NOTIFY). */
  notify?: boolean;
}

export const DEAD_LETTER_QUEUE = "dead-letter";

export const QUEUES = {
  deliverLead: {
    name: "deliver-lead",
    retryLimit: 8,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 21_600,
    expireInSeconds: 120,
    deadLetter: DEAD_LETTER_QUEUE,
    notify: true,
  },
  /** Pick up recordings: scan our SFTP upload folders (Option A) and pull from providers (Option B). */
  recordingsScan: {
    name: "recordings-scan",
    retryLimit: 1,
    retryDelay: 30,
    retryBackoff: false,
    expireInSeconds: 900,
  },
  /** Re-match unmatched recordings, mark overdue consent. */
  recordingsMaintenance: {
    name: "recordings-maintenance",
    retryLimit: 1,
    retryDelay: 30,
    retryBackoff: false,
    expireInSeconds: 300,
  },
  /** Push a lead's new consent-recording status to the destination (if already delivered). */
  syncConsent: {
    name: "sync-consent",
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 120,
    deadLetter: DEAD_LETTER_QUEUE,
  },
  retentionPurge: {
    name: "retention-purge",
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: false,
    expireInSeconds: 3_600,
  },
  heartbeat: {
    name: "system-heartbeat",
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    expireInSeconds: 60,
  },
} as const satisfies Record<string, QueueDefinition>;

export const ALL_QUEUES: QueueDefinition[] = [
  {
    name: DEAD_LETTER_QUEUE,
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    expireInSeconds: 60,
  },
  ...Object.values(QUEUES),
];
