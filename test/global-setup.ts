/**
 * Provides a real PostgreSQL server for integration tests.
 *  - If TEST_DATABASE_URL is set (CI service container), it is used as the admin connection.
 *  - Otherwise a disposable postgres:16 container is started with Testcontainers (needs Docker).
 * Each test file then creates its own empty database from it (see test/helpers.ts).
 */

import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const fromEnv = process.env.TEST_DATABASE_URL;
  if (fromEnv) {
    project.provide("pgAdminUrl", fromEnv);
    return;
  }

  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  project.provide("pgAdminUrl", container.getConnectionUri());

  return async () => {
    await container.stop();
  };
}
