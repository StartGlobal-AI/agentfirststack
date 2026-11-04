import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";
import { bundleRuntime } from "./scripts/build-runtime.mjs";

/** Text modules (wrangler `rules`) for Vite: dist/runtime*.txt are bundled on the fly. */
const textModules: Plugin = {
  name: "afs-text-modules",
  enforce: "pre",
  async load(id) {
    if (!id.endsWith(".txt")) return null;
    const text = id.endsWith("dist/runtime.txt")
      ? await bundleRuntime()
      : id.endsWith("dist/runtime-ext.txt")
        ? await bundleRuntime({ ext: true })
        : readFileSync(id, "utf8");
    return `export default ${JSON.stringify(text)};`;
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["test/*.test.ts"], environment: "node" },
      },
      {
        plugins: [
          textModules,
          cloudflareTest(async () => ({
            main: "./src/index.ts",
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // The pool bundles an older workerd than wrangler 4.156; pin a date it supports.
              compatibilityDate: "2026-08-01",
              // The app's own rate limiters stay out of the way (tests send many hits from one
              // "network"); their logic is tested with stub limiters.
              ratelimits: Object.fromEntries(
                [
                  ["COLLECT_IP_LIMITER", "42011"],
                  ["COLLECT_CONTAINER_LIMITER", "42012"],
                  ["CONVERSION_IP_LIMITER", "42013"],
                  ["CONVERSION_CONTAINER_LIMITER", "42014"],
                  ["SCAN_LIMITER", "42015"],
                  ["TEST_LIMITER", "42016"],
                  ["SERVER_EVENTS_LIMITER", "42017"],
                ].map(([name, namespace_id]) => [name, { namespace_id: namespace_id!, simple: { limit: 1_000_000, period: 60 as const } }]),
              ),
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
                // The shared identity DB (AUTH_DB), as on the hosted platform.
                TEST_AUTH_MIGRATIONS: await readD1Migrations("../site/migrations"),
                // Fair-use controls stay off in tests (deployments may turn them on).
                PUBLIC_BASE_URL: "",
                ANALYTICS_BASE_URL: "",
                SIGNUP_HOURLY_LIMIT: "0",
                MAX_CONTAINERS_PER_ACCOUNT: "",
                UNCLAIMED_MAX_CONTAINERS_PER_ACCOUNT: "",
                MAX_TAGS_BYTES_PER_ACCOUNT: "",
                UNCLAIMED_MAX_TAGS_BYTES_PER_ACCOUNT: "",
                MAX_CUSTOM_CODE_BYTES: "",
                ALLOW_CUSTOM_CODE: "",
                UNCLAIMED_ALLOW_CUSTOM_CODE: "",
                MAX_DELIVERIES_PER_CONTAINER_PER_DAY: "",
                MAX_DELIVERIES_PER_ACCOUNT_PER_DAY: "",
                MAX_DELIVERIES_PER_DAY: "",
                MAX_EVENTS_PER_CONTAINER_PER_DAY: "",
                MAX_EVENTS_PER_ACCOUNT_PER_DAY: "",
                UNCLAIMED_MAX_EVENTS_PER_ACCOUNT_PER_DAY: "",
                MAX_EVENTS_PER_DAY: "",
                UNCLAIMED_MAX_EVENTS_PER_DAY: "",
                MAX_VISITORS_PER_CONTAINER: "",
                MAX_CONTAINER_DB_BYTES: "",
                CIRCUIT_BREAKER_FAILURES: "",
                CIRCUIT_BREAKER_MINUTES: "",
                ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                DEV_MODE: "true",
                ANALYTICS_BASE_URL: "https://analytics.test",
              },
            },
          })),
        ],
        test: { name: "integration", include: ["test/integration/*.test.ts"], setupFiles: ["./test/integration/setup.ts"] },
      },
    ],
  },
});
