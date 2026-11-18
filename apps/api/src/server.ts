/**
 * API service entry point.
 * Migrations are NOT run here: they run as a separate release step (`npm run db:migrate`,
 * Railway pre-deploy command). /health/ready reports not_ready until the schema is current.
 */

import { ConfigError, loadConfig } from "@lim/config";
import { createDb } from "@lim/db";
import { createBoss, ensureQueues } from "@lim/jobs";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config);
  // Producer only: the API enqueues jobs; the worker runs them and maintains the queues.
  const boss = createBoss(config, { poolMax: 3, role: "producer" });
  await boss.start();
  await ensureQueues(boss, config); // idempotent; lets the API accept leads even before the worker first starts
  const app = await buildApp({ config, db, boss });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await boss.stop({ graceful: true, timeout: 10_000 });
      await db.destroy();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err: unknown) => {
  // Config errors list variable names only; anything else gets a generic message plus the error.
  if (err instanceof ConfigError) console.error(err.message);
  else console.error("API failed to start:", err);
  process.exit(1);
});
