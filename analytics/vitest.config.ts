import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Two projects: pure logic + the engine over node:sqlite (fast, Node), and the whole Worker +
// SiteDO + D1 inside workerd via @cloudflare/vitest-pool-workers. `pnpm test` builds the tracker
// first (dist/tracker.txt is imported by the Worker and by the tracker DOM test).
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                SALT_SECRET: "integration-test-salt",
                DEV_MODE: "true",
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
                // The shared identity DB (AUTH_DB), as on the hosted platform.
                TEST_AUTH_MIGRATIONS: await readD1Migrations("../site/migrations"),
                MAX_SITES_PER_ACCOUNT: "",
                SIGNUP_HOURLY_LIMIT: "0",
                // Low, so the SQL test can show a real DO cursor being stopped by its rowsRead.
                SQL_MAX_ROWS_READ: "2000",
              },
            },
          })),
        ],
        test: { name: "integration", include: ["test/integration/**/*.test.ts"], setupFiles: ["./test/integration/setup.ts"] },
      },
    ],
  },
});
