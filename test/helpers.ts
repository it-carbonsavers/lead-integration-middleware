/**
 * Integration test helpers: an isolated, migrated database per test file and a test config.
 */

import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { loadConfig, type Env } from "@lim/config";
import { createDb, migrateToLatest, type Database } from "@lim/db";
import type { Kysely } from "kysely";

// Fixed per test run (random), never real keys.
const TEST_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const TEST_BLIND_INDEX_KEY = randomBytes(32).toString("base64");

export interface TestDatabase {
  url: string;
  db: Kysely<Database>;
  config: Env;
  destroy: () => Promise<void>;
}

export function testConfig(databaseUrl: string, overrides: Record<string, string> = {}): Env {
  return loadConfig({
    NODE_ENV: "test",
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: "4",
    APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    APP_BLIND_INDEX_KEY: TEST_BLIND_INDEX_KEY,
    ...overrides,
  });
}

/** Creates a fresh database, runs all migrations, returns a Kysely handle. */
export async function createTestDatabase(
  options: { migrate?: boolean; config?: Record<string, string> } = {},
): Promise<TestDatabase> {
  const adminUrl = inject("pgAdminUrl");
  const name = `lim_test_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const config = testConfig(url.toString(), options.config);
  const db = createDb(config);

  if (options.migrate !== false) {
    const run = await migrateToLatest(db);
    if (run.error) throw run.error;
  }

  return {
    url: url.toString(),
    db,
    config,
    async destroy() {
      await db.destroy();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Starts a producer pg-boss on the test database with all queues created. */
export async function startTestBoss(t: TestDatabase) {
  const { createBoss, ensureQueues } = await import("@lim/jobs");
  const boss = createBoss(t.config, { poolMax: 2, role: "producer" });
  await boss.start();
  await ensureQueues(boss, t.config);
  return boss;
}
