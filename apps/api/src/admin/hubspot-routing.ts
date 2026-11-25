/**
 * Where leads actually go, for the environment notice in the admin.
 *
 * HubSpot calls are made by the worker, so its HUBSPOT_ENABLED (reported on every heartbeat) is what
 * counts; the API's own setting may differ. When HubSpot is on, the sources routed to a HubSpot
 * destination (their own, or the standard one) are listed.
 */

import { sql, type Kysely } from "kysely";
import type { Env } from "@lim/config";
import type { Database } from "@lim/db";

export interface HubSpotRouting {
  enabled: boolean;
  /** Provider codes whose leads go to HubSpot. */
  sources: string[];
  /** True when every active source goes to HubSpot. */
  all_sources: boolean;
}

export async function hubspotRouting(
  db: Kysely<Database>,
  config: Pick<Env, "HUBSPOT_ENABLED">,
): Promise<HubSpotRouting> {
  const worker = await db
    .selectFrom("service_status")
    .select(sql<boolean | null>`(detail->>'hubspot_enabled')::boolean`.as("enabled"))
    .where("name", "=", "worker")
    .executeTakeFirst();
  const enabled = config.HUBSPOT_ENABLED || worker?.enabled === true;
  if (!enabled) return { enabled: false, sources: [], all_sources: false };

  const rows = await db
    .selectFrom("platforms as p")
    .leftJoin("destinations as own", "own.id", "p.destination_id")
    .leftJoin("destinations as std", (j) => j.on("std.is_default", "=", true))
    .select(["p.code", sql<boolean>`coalesce(own.type, std.type) = 'hubspot'`.as("to_hubspot")])
    .where("p.status", "=", "active")
    .orderBy("p.code")
    .execute();
  const sources = rows.filter((r) => r.to_hubspot).map((r) => r.code);
  return { enabled: true, sources, all_sources: rows.length > 0 && sources.length === rows.length };
}
