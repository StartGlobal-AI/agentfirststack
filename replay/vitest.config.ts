import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Two projects: pure logic + the per-site engine over node:sqlite (fast, Node), and the whole
// Worker + ReplaySiteDO + D1 + R2 inside workerd via @cloudflare/vitest-pool-workers. `pnpm test`
// builds the browser bundles first (dist/*.txt is imported by the Worker and by the bundle tests).
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" } },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // The analytics Worker isn't part of this run: a placeholder keeps workerd starting;
              // forwarding tests pass an env with an in-isolate stub instead.
              serviceBindings: { ANALYTICS: () => new Response("not wired in tests", { status: 503 }) },
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
                // The shared identity DB (AUTH_DB), as on the hosted platform.
                TEST_AUTH_MIGRATIONS: await readD1Migrations("../site/migrations"),
                DEV_MODE: "true",
                // Hosted vars stay neutral in tests (and override a local .dev.vars); fair-use tests set their own.
                PUBLIC_BASE_URL: "",
                AUTH_ISSUER: "",
                SIGNUP_HOURLY_LIMIT: "0",
                MAX_SITES_PER_ACCOUNT: "",
                MAX_SAMPLE_RATE: "",
                MAX_SESSION_MINUTES: "",
                MAX_SESSIONS_PER_SITE_PER_DAY: "",
                MAX_CHUNK_BYTES: "",
                MAX_SESSION_BYTES: "",
                MAX_RETENTION_DAYS: "",
                MAX_LINKS_PER_SITE: "",
                INTERNAL_TOKEN: "",
              },
            },
          })),
        ],
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: ["./test/integration/setup.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
