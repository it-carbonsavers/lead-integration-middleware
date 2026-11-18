/**
 * Local development seed. Refuses to run unless APP_ENV is "local" or "test".
 *
 * Creates (idempotently):
 *   - organisation  carbon-savers
 *   - destination   "Local mock (HubSpot preview)"  type=mock, DEFAULT  -> nothing leaves the machine
 *   - destination   "HubSpot (disabled until approved)" type=hubspot, not default
 *   - platforms     PRV01 Lead Provider A         (rate limit 120/min)
 *                   PRV02 Lead Provider B
 *                   PRV03 Lead Provider C         (IP allow-list: localhost only)
 *                   PRV04 Lead Provider D         (suspended, to demonstrate 403)
 *   - one API key per platform, written to .local/provider-keys.json (git-ignored, mode 600)
 *
 *   - admin dashboard test accounts (super_admin, operator, analyst, compliance, and two
 *     lead-provider portal logins for PRV01 and PRV02) with random
 *     passwords, written to .local/admin-accounts.json (git-ignored, mode 600)
 *
 *   - consent recording delivery over the local development SFTP server:
 *       PRV01 = Option A (provider uploads to our SFTP server, account "prv01")
 *       PRV02 = Option B (we pull from a simulated provider server, account "outbox-prv02")
 *     with test SSH keys under .local/sftp/keys (git-ignored)
 *
 * Re-running keeps existing data; pass --rotate-keys to issue fresh keys (old ones are revoked)
 * and --reset-admin-passwords to give the test accounts new passwords.
 * Provider names are deliberately generic placeholders.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { apiKeyEnvTag, ConfigError, loadConfig } from "@lim/config";
import {
  createDb,
  createDestination,
  createOrganisation,
  createPlatform,
  findOrganisationBySlug,
  findPlatformByCode,
  issueApiCredential,
  listDestinations,
  revokeApiCredential,
  setPlatformStatus,
  type Actor,
} from "@lim/db";

import { ADMIN_ACCOUNTS_FILE, KEYS_FILE } from "./seed-paths.js";
import { generatePassword, hashPassword } from "../admin/auth.js";
import { seedSftp } from "./seed-sftp.js";

const ADMIN_ACCOUNTS: { email: string; name: string; roles: string[]; platform?: string }[] = [
  { email: "admin@local.test", name: "Local Super Admin", roles: ["super_admin"] },
  { email: "operator@local.test", name: "Local Operator", roles: ["operator"] },
  { email: "analyst@local.test", name: "Local Analyst", roles: ["analyst"] },
  { email: "compliance@local.test", name: "Local Compliance", roles: ["compliance"] },
  // Lead-provider portal logins: each sees only its own provider's leads.
  {
    email: "provider-a@local.test",
    name: "Lead Provider A user",
    roles: ["provider_viewer"],
    platform: "PRV01",
  },
  {
    email: "provider-b@local.test",
    name: "Lead Provider B user",
    roles: ["provider_viewer"],
    platform: "PRV02",
  },
];

const PLATFORMS = [
  { code: "PRV01", name: "Lead Provider A", rate: 120, cidrs: [] as string[], suspended: false },
  { code: "PRV02", name: "Lead Provider B", rate: null, cidrs: [], suspended: false },
  {
    code: "PRV03",
    name: "Lead Provider C (IP restricted)",
    rate: null,
    cidrs: ["127.0.0.1/32", "::1/128"],
    suspended: false,
  },
  { code: "PRV04", name: "Lead Provider D (suspended)", rate: null, cidrs: [], suspended: true },
];

interface KeysFile {
  generated_at: string;
  base_url: string;
  keys: Record<string, { prefix: string; token: string }>;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_ENV !== "local" && config.APP_ENV !== "test") {
    throw new Error(`seed only runs with APP_ENV=local or test (current: ${config.APP_ENV})`);
  }
  const rotate = process.argv.includes("--rotate-keys");
  const db = createDb(config);
  const actor: Actor = { type: "system", label: `seed:${userInfo().username}` };

  try {
    const org =
      (await findOrganisationBySlug(db, "carbon-savers")) ??
      (await createOrganisation(db, { name: "Carbon Savers", slug: "carbon-savers" }, actor));
    console.log(`organisation      ${org.slug}`);

    const destinations = await listDestinations(db);
    if (!destinations.some((d) => d.type === "mock")) {
      await createDestination(
        db,
        {
          type: "mock",
          name: "Local mock (HubSpot preview)",
          isDefault: true,
          config: {},
          credentialRef: "NONE_REQUIRED",
        },
        actor,
      );
    }
    if (!destinations.some((d) => d.type === "hubspot")) {
      await createDestination(
        db,
        {
          type: "hubspot",
          name: "HubSpot (disabled until approved)",
          isDefault: false,
          config: {},
          credentialRef: "HUBSPOT_PRIVATE_APP_TOKEN",
        },
        actor,
      );
    }
    for (const d of await listDestinations(db)) {
      console.log(
        `destination       ${d.type.padEnd(8)} ${d.is_default ? "DEFAULT " : "        "} ${d.name}`,
      );
    }

    let existing: KeysFile | null = null;
    try {
      existing = JSON.parse(await readFile(KEYS_FILE, "utf8")) as KeysFile;
    } catch {
      existing = null;
    }
    const keys: KeysFile["keys"] = {};

    for (const spec of PLATFORMS) {
      const platform =
        (await findPlatformByCode(db, spec.code)) ??
        (await createPlatform(
          db,
          {
            organisationId: org.id,
            code: spec.code,
            displayName: spec.name,
            rateLimitPerMin: spec.rate,
            allowedCidrs: spec.cidrs,
          },
          actor,
        ));
      if (spec.suspended && platform.status !== "suspended") {
        await setPlatformStatus(db, platform.id, "suspended", actor);
      }

      const prior = existing?.keys[spec.code];
      const priorActive =
        prior &&
        (await db
          .selectFrom("platform_api_credentials")
          .select("id")
          .where("key_prefix", "=", prior.prefix)
          .where("revoked_at", "is", null)
          .executeTakeFirst());
      if (prior && priorActive && !rotate) {
        keys[spec.code] = prior;
      } else {
        if (prior && priorActive) await revokeApiCredential(db, prior.prefix, actor);
        const issued = await issueApiCredential(
          db,
          { platformId: platform.id, envTag: apiKeyEnvTag(config.APP_ENV), label: "local seed" },
          actor,
        );
        keys[spec.code] = { prefix: issued.prefix, token: issued.token };
      }
      console.log(
        `platform          ${spec.code}  ${spec.name.padEnd(32)} key prefix ${keys[spec.code]!.prefix}`,
      );
    }

    await mkdir(dirname(KEYS_FILE), { recursive: true });
    const out: KeysFile = {
      generated_at: new Date().toISOString(),
      base_url: `http://localhost:${config.PORT}`,
      keys,
    };
    await writeFile(KEYS_FILE, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
    await chmod(KEYS_FILE, 0o600);
    console.log(`\nLocal provider API keys written to ${KEYS_FILE} (git-ignored). Test keys only.`);

    // --- Admin dashboard test accounts ---------------------------------------------
    const resetPasswords = process.argv.includes("--reset-admin-passwords");
    let priorAccounts: Record<string, string> = {};
    try {
      priorAccounts = (
        JSON.parse(await readFile(ADMIN_ACCOUNTS_FILE, "utf8")) as {
          accounts: Record<string, string>;
        }
      ).accounts;
    } catch {
      priorAccounts = {};
    }
    const accounts: Record<string, string> = {};
    for (const a of ADMIN_ACCOUNTS) {
      const existing = await db
        .selectFrom("admin_users")
        .select("id")
        .where("email", "=", a.email)
        .executeTakeFirst();
      if (existing && priorAccounts[a.email] && !resetPasswords) {
        accounts[a.email] = priorAccounts[a.email]!;
      } else {
        const password = generatePassword();
        const passwordHash = await hashPassword(password);
        if (existing) {
          await db
            .updateTable("admin_users")
            .set({
              password_hash: passwordHash,
              password_changed_at: new Date(),
              status: "active",
              locked_until: null,
              failed_login_count: 0,
            })
            .where("id", "=", existing.id)
            .execute();
        } else {
          const u = await db
            .insertInto("admin_users")
            .values({
              email: a.email,
              name: a.name,
              auth_provider: "local",
              password_hash: passwordHash,
              password_changed_at: new Date(),
              status: "active",
              ...(a.platform
                ? {
                    platform_id: (await findPlatformByCode(db, a.platform))!.id,
                    organisation_id: org.id,
                  }
                : {}),
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          await db
            .insertInto("admin_user_roles")
            .values(a.roles.map((role_code) => ({ user_id: u.id, role_code })))
            .execute();
        }
        accounts[a.email] = password;
      }
      console.log(
        `admin account     ${a.email.padEnd(24)} ${a.roles.join(", ")}${a.platform ? ` (${a.platform})` : ""}`,
      );
    }
    await writeFile(
      ADMIN_ACCOUNTS_FILE,
      JSON.stringify(
        { note: "LOCAL TEST ACCOUNTS ONLY", dashboard_url: "http://localhost:3001", accounts },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await chmod(ADMIN_ACCOUNTS_FILE, 0o600);
    console.log(`Admin test account passwords written to ${ADMIN_ACCOUNTS_FILE} (git-ignored).`);

    // --- Consent recordings over SFTP (local test setup) ---------------------------
    await seedSftp(db, config);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError || err instanceof Error ? err.message : "seed failed");
  process.exit(1);
});
