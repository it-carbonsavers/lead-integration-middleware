/**
 * Migration CLI.  Usage: migrate [up|down|status]
 * Runs as Railway's pre-deploy command in staging/production (see infra/railway).
 */

import { loadConfig } from "@lim/config";
import { createDb } from "../client.js";
import { migrateDown, migrateToLatest, migrationStatus } from "../migrate.js";

async function main(): Promise<number> {
  const command = process.argv[2] ?? "up";
  const config = loadConfig();
  const db = createDb(config);
  try {
    if (command === "status") {
      for (const m of await migrationStatus(db)) {
        console.log(
          `${m.executedAt ? "applied " : "pending "} ${m.name}${m.executedAt ? `  (${m.executedAt.toISOString()})` : ""}`,
        );
      }
      return 0;
    }
    if (command !== "up" && command !== "down") {
      console.error("Usage: migrate [up|down|status]");
      return 2;
    }
    const run = command === "up" ? await migrateToLatest(db) : await migrateDown(db);
    for (const r of run.results)
      console.log(`${r.status.padEnd(8)} ${r.direction.toLowerCase()} ${r.migrationName}`);
    if (run.results.length === 0) console.log("Nothing to do.");
    if (run.error) {
      console.error(
        "Migration failed:",
        run.error instanceof Error ? run.error.message : "unknown error",
      );
      return 1;
    }
    return 0;
  } finally {
    await db.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : "Migration failed");
    process.exit(1);
  },
);
