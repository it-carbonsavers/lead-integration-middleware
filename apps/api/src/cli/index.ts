/**
 * Operator CLI for managing organisations, source platforms and API keys until the admin
 * backend exists (Phase 4). Every change is written to the audit log as actor "cli:<os user>".
 *
 *   npm run admin -- org:create      --name "Carbon Savers" --slug carbon-savers
 *   npm run admin -- platform:create --org carbon-savers --code PRV01 --name "Provider 01" [--rate-limit 120] [--cidr 203.0.113.0/24 ...]
 *   npm run admin -- platform:list
 *   npm run admin -- platform:suspend  --code PRV01
 *   npm run admin -- platform:activate --code PRV01
 *   npm run admin -- platform:access   --code PRV01 [--cidr ... | --clear-cidrs] [--rate-limit N | --default-rate-limit]
 *   npm run admin -- key:issue  --platform PRV01 [--label "primary"] [--expires-days 365]
 *   npm run admin -- key:list   --platform PRV01
 *   npm run admin -- key:revoke --prefix k7Hq2xAb
 *   npm run admin -- destination:create --type mock|hubspot --name "Local mock" [--default] [--config '{"leadStageId":"..."}'] [--credential-ref HUBSPOT_PRIVATE_APP_TOKEN]
 *   npm run admin -- destination:list
 *   npm run admin -- destination:default --id <uuid>
 *   npm run admin -- platform:destination --code PRV01 (--id <uuid> | --clear)
 *   npm run admin -- lead:show  --ref LD-...
 *   npm run admin -- lead:retry --ref LD-...
 *   npm run admin -- user:create --email you@example.com --name "Your Name" [--role super_admin]
 *       (dashboard user; prints a temporary password once. Used to create the first admin on a new
 *        environment; further users are added in the dashboard.)
 *
 * In production run the compiled build: node apps/api/dist/cli/index.js <command> ...
 */

import { userInfo } from "node:os";
import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { apiKeyEnvTag, ConfigError, loadConfig } from "@lim/config";
import {
  createDb,
  createOrganisation,
  createPlatform,
  findOrganisationBySlug,
  findPlatformByCode,
  issueApiCredential,
  listApiCredentials,
  listPlatforms,
  revokeApiCredential,
  setPlatformStatus,
  updatePlatformAccess,
  createDestination,
  listDestinations,
  setDefaultDestination,
  setPlatformDestination,
  writeAudit,
  type Actor,
} from "@lim/db";
import { ROLES } from "@lim/core";
import { DESTINATION_TYPES, hubSpotConfigSchema } from "@lim/destinations";
import { createBoss, ensureQueues } from "@lim/jobs";
import { generatePassword, hashPassword } from "../admin/auth.js";
import { LeadOpError, requeueLead } from "../services/lead-ops.js";

class UsageError extends Error {}

function required(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== "string" || v.trim() === "") throw new UsageError(`--${name} is required`);
  return v.trim();
}

function parseCidrs(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((c: string) => {
    const [addr, bits] = c.split("/");
    const fam = isIP(addr ?? "");
    const max = fam === 6 ? 128 : 32;
    if (!fam || (bits !== undefined && !(Number(bits) >= 0 && Number(bits) <= max))) {
      throw new UsageError(`invalid CIDR: ${c}`);
    }
    return c;
  });
}

function positiveInt(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      org: { type: "string" },
      code: { type: "string" },
      platform: { type: "string" },
      prefix: { type: "string" },
      label: { type: "string" },
      "rate-limit": { type: "string" },
      "default-rate-limit": { type: "boolean" },
      cidr: { type: "string", multiple: true },
      "clear-cidrs": { type: "boolean" },
      "expires-days": { type: "string" },
      type: { type: "string" },
      default: { type: "boolean" },
      config: { type: "string" },
      "credential-ref": { type: "string" },
      id: { type: "string" },
      clear: { type: "boolean" },
      ref: { type: "string" },
      email: { type: "string" },
      role: { type: "string" },
    },
    strict: true,
  });

  const config = loadConfig();
  const db = createDb(config);
  const actor: Actor = { type: "system", label: `cli:${userInfo().username}` };

  const platformByCode = async (code: string) => {
    const p = await findPlatformByCode(db, code);
    if (!p) throw new UsageError(`platform not found: ${code}`);
    return p;
  };

  try {
    switch (command) {
      case "org:create": {
        const org = await createOrganisation(
          db,
          { name: required(values, "name"), slug: required(values, "slug") },
          actor,
        );
        console.log(`Organisation created: ${org.slug} (${org.id})`);
        return 0;
      }
      case "platform:create": {
        const org = await findOrganisationBySlug(db, required(values, "org"));
        if (!org) throw new UsageError("organisation not found");
        const p = await createPlatform(
          db,
          {
            organisationId: org.id,
            code: required(values, "code"),
            displayName: required(values, "name"),
            rateLimitPerMin: positiveInt(values["rate-limit"], "rate-limit") ?? null,
            allowedCidrs: parseCidrs(values.cidr),
          },
          actor,
        );
        console.log(`Platform created: ${p.code} (${p.id})`);
        return 0;
      }
      case "platform:list": {
        console.table(
          (await listPlatforms(db)).map((p) => ({
            code: p.code,
            name: p.display_name,
            status: p.status,
            organisation: p.organisation_slug,
            rate_limit:
              p.rate_limit_per_min ?? `default (${config.RATE_LIMIT_PLATFORM_DEFAULT_PER_MIN})`,
            allowed_cidrs: p.allowed_cidrs.join(", ") || "any",
          })),
        );
        return 0;
      }
      case "platform:suspend":
      case "platform:activate": {
        const p = await platformByCode(required(values, "code"));
        await setPlatformStatus(
          db,
          p.id,
          command === "platform:suspend" ? "suspended" : "active",
          actor,
        );
        console.log(
          `Platform ${p.code} ${command === "platform:suspend" ? "suspended" : "activated"}.`,
        );
        return 0;
      }
      case "platform:access": {
        const p = await platformByCode(required(values, "code"));
        const rate = values["default-rate-limit"]
          ? null
          : positiveInt(values["rate-limit"], "rate-limit");
        const cidrs = values["clear-cidrs"]
          ? []
          : values.cidr
            ? parseCidrs(values.cidr)
            : undefined;
        if (rate === undefined && cidrs === undefined) throw new UsageError("nothing to change");
        await updatePlatformAccess(
          db,
          p.id,
          {
            ...(cidrs !== undefined ? { allowedCidrs: cidrs } : {}),
            ...(rate !== undefined ? { rateLimitPerMin: rate } : {}),
          },
          actor,
        );
        console.log(`Platform ${p.code} access updated.`);
        return 0;
      }
      case "key:issue": {
        const p = await platformByCode(required(values, "platform"));
        const days = positiveInt(values["expires-days"], "expires-days");
        const issued = await issueApiCredential(
          db,
          {
            platformId: p.id,
            envTag: apiKeyEnvTag(config.APP_ENV),
            label: values.label ?? null,
            expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null,
          },
          actor,
        );
        console.log(
          [
            `API key issued for ${p.code} (prefix ${issued.prefix}${issued.expiresAt ? `, expires ${issued.expiresAt.toISOString()}` : ""}).`,
            "Copy it now and send it to the provider over a secure channel. It is not stored and cannot be shown again:",
            "",
            `  ${issued.token}`,
            "",
          ].join("\n"),
        );
        return 0;
      }
      case "key:list": {
        const p = await platformByCode(required(values, "platform"));
        console.table(
          (await listApiCredentials(db, p.id)).map((c) => ({
            prefix: c.key_prefix,
            env: c.env_tag,
            label: c.label ?? "",
            created: c.created_at.toISOString(),
            last_used: c.last_used_at?.toISOString() ?? "never",
            expires: c.expires_at?.toISOString() ?? "never",
            status: c.revoked_at
              ? "revoked"
              : c.expires_at && c.expires_at < new Date()
                ? "expired"
                : "active",
          })),
        );
        return 0;
      }
      case "key:revoke": {
        const ok = await revokeApiCredential(db, required(values, "prefix"), actor);
        console.log(ok ? "Key revoked." : "No active key with that prefix.");
        return ok ? 0 : 1;
      }
      case "destination:create": {
        const type = required(values, "type");
        if (!(DESTINATION_TYPES as readonly string[]).includes(type)) {
          throw new UsageError(`--type must be one of: ${DESTINATION_TYPES.join(", ")}`);
        }
        let cfgRaw: unknown = {};
        if (values.config) {
          try {
            cfgRaw = JSON.parse(values.config);
          } catch {
            throw new UsageError("--config must be JSON");
          }
        }
        const cfg = hubSpotConfigSchema.safeParse(cfgRaw);
        if (!cfg.success) throw new UsageError("--config is not a valid destination configuration");
        const credentialRef =
          values["credential-ref"] ??
          (type === "hubspot" ? "HUBSPOT_PRIVATE_APP_TOKEN" : "NONE_REQUIRED");
        const d = await createDestination(
          db,
          {
            type,
            name: required(values, "name"),
            isDefault: Boolean(values.default),
            config: cfg.data,
            credentialRef,
          },
          actor,
        );
        console.log(
          `Destination created: ${d.name} [${d.type}] (${d.id})${d.is_default ? " - default" : ""}`,
        );
        if (type === "hubspot" && !config.HUBSPOT_ENABLED) {
          console.log(
            "Note: HUBSPOT_ENABLED=false, so leads routed here will fail with hubspot_disabled. Nothing is sent to HubSpot.",
          );
        }
        return 0;
      }
      case "destination:list": {
        console.table(
          (await listDestinations(db)).map((d) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            default: d.is_default,
            status: d.status,
            credential_ref: d.credential_ref,
          })),
        );
        return 0;
      }
      case "destination:default": {
        await setDefaultDestination(db, required(values, "id"), actor);
        console.log("Default destination updated.");
        return 0;
      }
      case "platform:destination": {
        const p = await platformByCode(required(values, "code"));
        const id = values.clear ? null : required(values, "id");
        await setPlatformDestination(db, p.id, id, actor);
        console.log(
          id
            ? `Platform ${p.code} now routes to ${id}.`
            : `Platform ${p.code} uses the default destination.`,
        );
        return 0;
      }
      case "lead:show": {
        const ref = required(values, "ref");
        const lead = await db
          .selectFrom("leads as l")
          .innerJoin("platforms as p", "p.id", "l.platform_id")
          .select([
            "l.id",
            "l.lead_ref",
            "l.external_lead_id",
            "p.code as platform",
            "l.status",
            "l.consent_status",
            "l.attempt_count",
            "l.last_error_code",
            "l.received_at",
            "l.delivered_at",
            "l.destination_ids",
          ])
          .where("l.lead_ref", "=", ref)
          .executeTakeFirst();
        if (!lead) throw new UsageError("lead not found");
        const { id, ...summary } = lead;
        console.log("Lead (personal data not shown):");
        console.table([summary]);
        const events = await db
          .selectFrom("lead_events")
          .select(["created_at", "type", "from_status", "to_status", "actor_type", "detail"])
          .where("lead_id", "=", id)
          .orderBy("id")
          .execute();
        console.log("Timeline:");
        console.table(events.map((e) => ({ ...e, detail: JSON.stringify(e.detail) })));
        const attempts = await db
          .selectFrom("delivery_attempts")
          .select([
            "attempt_no",
            "status",
            "http_status",
            "error_code",
            "started_at",
            "finished_at",
            "step_results",
          ])
          .where("lead_id", "=", id)
          .orderBy("attempt_no")
          .execute();
        console.log("Delivery attempts:");
        console.table(
          attempts.map((a) => ({ ...a, step_results: JSON.stringify(a.step_results) })),
        );
        return 0;
      }
      case "lead:retry": {
        const boss = createBoss(config, { poolMax: 1, role: "producer" });
        await boss.start();
        try {
          await ensureQueues(boss, config);
          await requeueLead(db, boss, required(values, "ref"), actor);
          console.log("Lead re-queued for delivery.");
        } catch (e) {
          if (e instanceof LeadOpError) throw new UsageError(e.message);
          throw e;
        } finally {
          await boss.stop({ graceful: true, timeout: 5_000 });
        }
        return 0;
      }
      case "user:create": {
        const email = required(values, "email").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UsageError("--email is not valid");
        const role = (values.role as string | undefined) ?? "super_admin";
        if (!(role in ROLES) || role === "provider_viewer")
          throw new UsageError(
            `--role must be one of: ${Object.keys(ROLES)
              .filter((r) => r !== "provider_viewer")
              .join(", ")}`,
          );
        const tempPassword = generatePassword();
        const passwordHash = await hashPassword(tempPassword);
        await db.transaction().execute(async (trx) => {
          const u = await trx
            .insertInto("admin_users")
            .values({
              email,
              name: required(values, "name"),
              auth_provider: "local",
              password_hash: passwordHash,
              password_changed_at: new Date(),
              status: "active",
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          await trx
            .insertInto("admin_user_roles")
            .values({ user_id: u.id, role_code: role })
            .execute();
          await writeAudit(trx, {
            actorType: actor.type,
            actorId: null,
            actorLabel: actor.label,
            action: "user.created",
            targetType: "admin_user",
            targetId: u.id,
            detail: { email, roles: [role], via: "cli" },
          });
        });
        console.log(`Created ${email} (${role}).`);
        console.log(`Temporary password (shown once, change it after signing in): ${tempPassword}`);
        return 0;
      }
      default:
        throw new UsageError(
          `unknown command: ${command ?? "(none)"}. See the header of apps/api/src/cli/index.ts`,
        );
    }
  } finally {
    await db.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError || err instanceof ConfigError) console.error(err.message);
    else if (err && typeof err === "object" && "code" in err && err.code === "23505")
      console.error("Already exists (unique value conflict).");
    else if (err && typeof err === "object" && "code" in err && err.code === "23514")
      console.error("Value rejected by a database rule (check format of code/slug).");
    else console.error("Command failed:", err instanceof Error ? err.message : "unknown error");
    process.exit(1);
  },
);
