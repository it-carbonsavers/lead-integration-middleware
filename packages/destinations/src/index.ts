/**
 * Destination adapter factory: turns a `destinations` row into an adapter.
 * Adding a CRM = add an adapter here + a destination row. Nothing else changes.
 */

import type { Kysely } from "kysely";
import type { Env } from "@lim/config";
import { DestinationError, type DestinationAdapter } from "@lim/core";
import type { Database, Destination } from "@lim/db";
import { HubSpotAdapter, type FetchLike } from "./hubspot/adapter.js";
import { hubSpotConfigSchema } from "./hubspot/mapping.js";
import { MockDestinationAdapter } from "./mock/adapter.js";

export { HubSpotAdapter, type FetchLike } from "./hubspot/adapter.js";
export { MockDestinationAdapter } from "./mock/adapter.js";
export * from "./hubspot/mapping.js";

export const DESTINATION_TYPES = ["mock", "hubspot"] as const;

export interface AdapterDeps {
  db: Kysely<Database>;
  config: Env;
  /** Environment to read credential_ref from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injected HTTP client for tests. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export function createAdapter(destination: Destination, deps: AdapterDeps): DestinationAdapter {
  const parsed = hubSpotConfigSchema.safeParse(destination.config ?? {});
  if (!parsed.success) {
    throw new DestinationError(
      "permanent",
      "destination_config_invalid",
      "Destination configuration is invalid",
    );
  }
  const cfg = parsed.data;

  switch (destination.type) {
    case "mock":
      return new MockDestinationAdapter({
        db: deps.db,
        destinationId: destination.id,
        config: cfg,
        encryptionKey: deps.config.APP_ENCRYPTION_KEY,
        blindIndexKey: deps.config.APP_BLIND_INDEX_KEY,
      });
    case "hubspot":
      return new HubSpotAdapter({
        enabled: deps.config.HUBSPOT_ENABLED,
        baseUrl: deps.config.HUBSPOT_BASE_URL,
        token: (deps.env ?? process.env)[destination.credential_ref],
        config: cfg,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
    default:
      throw new DestinationError(
        "permanent",
        "destination_type_unknown",
        "Unknown destination type",
      );
  }
}
