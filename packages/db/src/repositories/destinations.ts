/**
 * Destination configuration. Secrets are never stored here: `credential_ref` is the NAME of an
 * environment variable that holds the token (e.g. HUBSPOT_PRIVATE_APP_TOKEN).
 */

import type { Kysely } from "kysely";
import type { Database, Destination } from "../schema.js";
import { writeAudit } from "./audit.js";
import type { Actor } from "./platforms.js";

export interface CreateDestinationInput {
  type: string;
  name: string;
  isDefault: boolean;
  config: Record<string, unknown>;
  credentialRef: string;
}

export async function createDestination(
  db: Kysely<Database>,
  input: CreateDestinationInput,
  actor: Actor,
): Promise<Destination> {
  return db.transaction().execute(async (trx) => {
    if (input.isDefault) {
      await trx
        .updateTable("destinations")
        .set({ is_default: false })
        .where("is_default", "=", true)
        .execute();
    }
    const d = await trx
      .insertInto("destinations")
      .values({
        type: input.type,
        name: input.name,
        is_default: input.isDefault,
        config: JSON.stringify(input.config),
        credential_ref: input.credentialRef,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorLabel: actor.label ?? null,
      action: "destination.created",
      targetType: "destination",
      targetId: d.id,
      detail: { type: d.type, name: d.name, is_default: d.is_default },
    });
    return d;
  });
}

export async function setDefaultDestination(db: Kysely<Database>, id: string, actor: Actor) {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("destinations")
      .set({ is_default: false })
      .where("is_default", "=", true)
      .execute();
    const d = await trx
      .updateTable("destinations")
      .set({ is_default: true })
      .where("id", "=", id)
      .returning(["id", "type", "name"])
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorLabel: actor.label ?? null,
      action: "destination.updated",
      targetType: "destination",
      targetId: d.id,
      detail: { is_default: true, type: d.type },
    });
  });
}

export async function listDestinations(db: Kysely<Database>) {
  return db.selectFrom("destinations").selectAll().orderBy("created_at").execute();
}

export async function setPlatformDestination(
  db: Kysely<Database>,
  platformId: string,
  destinationId: string | null,
  actor: Actor,
) {
  await db.transaction().execute(async (trx) => {
    const p = await trx
      .updateTable("platforms")
      .set({ destination_id: destinationId })
      .where("id", "=", platformId)
      .returning(["id", "code", "organisation_id"])
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorLabel: actor.label ?? null,
      organisationId: p.organisation_id,
      action: "platform.updated",
      targetType: "platform",
      targetId: p.id,
      detail: { code: p.code, destination_id: destinationId },
    });
  });
}

/** Platform override first, then the default destination. Disabled destinations are skipped. */
export async function resolveDestinationForPlatform(
  db: Kysely<Database>,
  platformId: string,
): Promise<Destination | undefined> {
  const override = await db
    .selectFrom("destinations")
    .innerJoin("platforms", "platforms.destination_id", "destinations.id")
    .selectAll("destinations")
    .where("platforms.id", "=", platformId)
    .where("destinations.status", "=", "active")
    .executeTakeFirst();
  if (override) return override;
  return db
    .selectFrom("destinations")
    .selectAll()
    .where("is_default", "=", true)
    .where("status", "=", "active")
    .executeTakeFirst();
}
