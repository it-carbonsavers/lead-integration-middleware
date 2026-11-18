/**
 * Health endpoints (public, no auth, no configuration details).
 *   GET /health/live   process is up (Railway restart signal)
 *   GET /health/ready  database reachable and schema migrations current (Railway deploy healthcheck)
 */

import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { isSchemaCurrent, pingDb, type Database } from "@lim/db";

export async function healthRoutes(
  app: FastifyInstance,
  opts: { db: Kysely<Database> },
): Promise<void> {
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const database = await pingDb(opts.db);
    const migrations = database && (await isSchemaCurrent(opts.db));
    const ready = database && migrations;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      checks: { database, migrations },
    });
  });
}
