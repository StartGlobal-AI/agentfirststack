import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects: pure logic + the per-site engine over node:sqlite (fast, Node), and the whole
// Worker + ReplaySiteDO + D1 + R2 inside workerd via @cloudflare/vitest-plugin. `pnpm test`
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
              // The read limits stay out of the way (a test makes many reads with one key); their
              // logic is tested with a stub limiter.
              ratelimits: {
                READ_LIMITER: { namespace_id: "42034", simple: { limit: 1_000_000, period: 60 } },
              },
              // The analytics and tags Workers aren't part of this run: placeholders keep workerd
              // starting; forwarding tests pass an env with an in-isolate stub instead.
              serviceBindings: {
                ANALYTICS: () => new Response("not wired in tests", { status: 503 }),
                TAGS: () => new Response("not wired in tests", { status: 503 }),
              },
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
                // The shared identity DB (AUTH_DB), as on the hosted platform.
                TEST_AUTH_MIGRATIONS: await readD1Migrations("../site/migrations"),
                DEV_MODE: "true",
                // Hosted vars stay neutral in tests (and override a local .dev.vars); fair-use tests set their own.
                PUBLIC_BASE_URL: "",
                // No user-content host (share links on /play/ here); its tests set their own.
                USER_CONTENT_BASE_URL: "",
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
                MAX_UNVERIFIED_SITES_PER_ACCOUNT: "",
                MAX_UNVERIFIED_SESSIONS_PER_SITE_PER_DAY: "",
                MAX_FORCED_SESSIONS_PER_SITE_PER_DAY: "",
                MAX_SESSIONS_PER_IP_PER_SITE_PER_DAY: "",
                MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY: "",
                MAX_TAGS_EVENTS_PER_SITE_PER_DAY: "",
                MAX_HEATMAP_IMAGES_PER_SITE_PER_DAY: "",
                MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY: "",
                MAX_PLATFORM_HEATMAP_IMAGES_PER_DAY: "",
                MAX_CHUNKS_PER_SESSION: "",
                MAX_DERIVED_PER_CHUNK: "",
                MAX_DERIVED_PER_SESSION: "",
                MAX_SESSIONS_PER_ACCOUNT_PER_DAY: "",
                MAX_CHUNKS_PER_ACCOUNT_PER_DAY: "",
                MAX_BYTES_PER_ACCOUNT_PER_DAY: "",
                MAX_DERIVED_PER_ACCOUNT_PER_DAY: "",
                MAX_PLATFORM_SESSIONS_PER_DAY: "",
                MAX_PLATFORM_CHUNKS_PER_DAY: "",
                MAX_PLATFORM_BYTES_PER_DAY: "",
                MAX_PLATFORM_DERIVED_PER_DAY: "",
                MAX_HEATMAP_RETENTION_DAYS: "",
                MAX_LINK_BYTES_PER_DAY: "",
                MAX_VERIFY_PER_ACCOUNT_PER_HOUR: "",
                CAPTURE_CONSOLE_ERRORS_DEFAULT: "",
                INTERNAL_TOKEN: "",
                // An obviously fake 32-byte key (0x01 * 32): webhook secrets are sealed with it in tests.
                ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                CAPTURE_NETWORK_ERRORS_DEFAULT: "",
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
