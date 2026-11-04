import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The site Worker inside workerd with a real local D1 (the identity DB). The services behind the
// ANALYTICS / TAGS / MAIL bindings are stubbed in test/helpers.ts with the real @afs/shared auth,
// so internal auth and OAuth access tokens are checked exactly as the services check them.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // The pool bundles an older workerd than wrangler 4.156; pin a date it supports.
        compatibilityDate: "2026-08-01",
        // The services (afs-analytics, ...) aren't part of this test run: placeholders keep workerd
        // starting, and tests pass an env with in-isolate stubs (test/helpers.ts) instead.
        serviceBindings: {
          ANALYTICS: () => new Response("not wired in tests", { status: 503 }),
          TAGS: () => new Response("not wired in tests", { status: 503 }),
          MAIL: () => new Response("not wired in tests", { status: 503 }),
          REPLAY: () => new Response("not wired in tests", { status: 503 }),
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // Hosted vars stay neutral in tests (and override a local .dev.vars).
          PUBLIC_BASE_URL: "",
          AUTH_ISSUER: "",
          SIGNUP_HOURLY_LIMIT: "0",
          SIGNUP_DAILY_LIMIT: "",
          SIGNUP_ASN_DAILY_LIMIT: "",
          SIGNUP_GLOBAL_HOURLY_LIMIT: "",
          MAX_KEYS_PER_ACCOUNT: "",
          UNCLAIMED_MAX_KEYS_PER_ACCOUNT: "",
          KEYS_HOURLY_LIMIT: "",
          OAUTH_REGISTER_HOURLY_LIMIT: "",
          PROJECTS_PER_USER_DAILY_LIMIT: "0",
          DEV_MODE: "true",
          INTERNAL_TOKEN: "test-internal-token-0123456789",
          GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
        },
      },
    })),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 30_000 },
});
