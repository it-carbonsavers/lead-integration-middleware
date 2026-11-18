/**
 * Audit log writer. The table is append-only (enforced by a database trigger).
 * `detail` must never contain raw personal data or secrets: ids, codes and counts only.
 */

import type { Kysely, Transaction } from "kysely";
import type { AuditAction } from "@lim/core";
import type { Database } from "../schema.js";

export interface AuditInput {
  actorType: "admin" | "platform" | "system";
  actorId?: string | null;
  /** Human-readable actor for system/CLI actions, e.g. "cli:jsmith" */
  actorLabel?: string | null;
  organisationId?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export async function writeAudit(
  db: Kysely<Database> | Transaction<Database>,
  entry: AuditInput,
): Promise<void> {
  await db
    .insertInto("audit_log")
    .values({
      actor_type: entry.actorType,
      actor_id: entry.actorId ?? null,
      actor_label: entry.actorLabel ?? null,
      organisation_id: entry.organisationId ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      request_id: entry.requestId ?? null,
      ip: entry.ip ?? null,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute();
}
