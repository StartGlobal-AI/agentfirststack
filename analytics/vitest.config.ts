import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** "" for a var and its UNCLAIMED_ form: capFor reads both as unset. */
const neutral = (names: string[]) =>
  Object.fromEntries(
    names.flatMap((n) => [
      [n, ""],
      [`UNCLAIMED_${n}`, ""],
    ]),
  );

// Two projects: pure logic + the engine over node:sqlite (fast, Node), and the whole Worker +
// SiteDO + D1 inside workerd via @cloudflare/vitest-plugin. `pnpm test` builds the tracker
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
                // Hosted fair-use vars off (tests turn them on per call with worker.fetch(req, {...env, X})).
                // Test accounts are unclaimed (AUTH_DB has the memberships table), so the UNCLAIMED_
                // forms are neutralised too.
                ...neutral([
                  "MAX_SITES_PER_ACCOUNT",
                  "MAX_ANNOTATIONS_PER_SITE",
                  "MAX_FUNNELS_PER_SITE",
                  "MAX_GOALS_PER_SITE",
                  "MAX_SHARE_LINKS_PER_SITE",
                  "MAX_EVENTS_PER_SITE_PER_DAY",
                  "MAX_EVENTS_PER_ACCOUNT_PER_DAY",
                  "DAILY_EVENT_BUDGET",
                  "MAX_SITE_STORAGE_MB",
                  "MIN_RETENTION_DAYS",
                  "MAX_RETENTION_DAYS",
                  "SQL_TIME_BUDGET_MS",
                  "MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY",
                  "MAX_QUARANTINED_EVENTS_PER_SITE_PER_DAY",
                  "SPIKE_MIN_EVENTS",
                ]),
                SIGNUP_HOURLY_LIMIT: "0",
                // Replay loading off (and a local .dev.vars overridden); tests that need it pass it per call.
                REPLAY_BASE_URL: "",
                // Seals the Stripe signing secret (tests for a missing key override it per call).
                ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                // Low, so the SQL test can show a real DO cursor being stopped by its rowsRead.
                SQL_MAX_ROWS_READ: "2000",
              },
              // Every test beacon comes from one address (no cf-connecting-ip): lift the per-IP and
              // per-site ingest limits for the suite. Tests of the limits themselves swap the binding.
              ratelimits: {
                INGEST_IP_LIMITER: { namespace_id: "42001", simple: { limit: 100000, period: 60 } },
                INGEST_SITE_LIMITER: { namespace_id: "42002", simple: { limit: 100000, period: 60 } },
                READ_LIMITER: { namespace_id: "42008", simple: { limit: 100000, period: 60 } },
              },
            },
          })),
        ],
        test: { name: "integration", include: ["test/integration/**/*.test.ts"], setupFiles: ["./test/integration/setup.ts"] },
      },
    ],
  },
});
