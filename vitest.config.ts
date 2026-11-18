import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against TypeScript sources of the workspace packages (no build needed).
    alias: {
      "@lim/config": src("./packages/config/src/index.ts"),
      "@lim/core": src("./packages/core/src/index.ts"),
      "@lim/db": src("./packages/db/src/index.ts"),
      "@lim/jobs": src("./packages/jobs/src/index.ts"),
      "@lim/destinations": src("./packages/destinations/src/index.ts"),
      "@lim/recordings": src("./packages/recordings/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: "forks",
  },
});
