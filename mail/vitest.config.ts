import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // Pure logic (extraction corpus, address rules, threading, signing, DNS, CF API builders): Node.
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" } },
      // The Worker itself in workerd: D1, R2, InboxDO, Queue producer, send_email (local simulator).
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
                // The shared identity DB (AUTH_DB), as on the hosted platform.
                TEST_AUTH_MIGRATIONS: await readD1Migrations("../site/migrations"),
                ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                SEND_DAILY_LIMIT: "6",
                // Fair-use controls stay off in tests (deployments may turn them on); fair-use tests set their own.
                MAIL_DOMAIN: "mail.example.com",
                PUBLIC_BASE_URL: "",
                // As deployed, whatever a local .dev.vars says; tests that need it set DEV_MODE themselves.
                DEV_MODE: "false",
                SIGNUP_HOURLY_LIMIT: "0",
                SHARED_SEND_POLICY: "",
                SHARED_RETENTION_DAYS: "",
                MAX_INBOXES_PER_ACCOUNT: "",
                MAX_MESSAGES_PER_INBOX: "",
                MAX_INBOUND_PER_ACCOUNT_PER_DAY: "",
                MAX_WEBHOOKS_PER_ACCOUNT: "",
                MAX_INBOX_CREATES_PER_DAY: "",
                MAX_INBOX_DELETES_PER_DAY: "",
                ADDRESS_TOMBSTONE_DAYS: "",
                MAX_INBOUND_PER_SENDER_PER_DAY: "",
                MAX_TEXT_BYTES_PER_ACCOUNT: "",
                // Unset: the safe default applies (1 GiB, 256 MiB unclaimed); its tests set their own.
                MAX_BLOB_BYTES_PER_ACCOUNT: "",
                MAX_CONCURRENT_WAITS: "",
                MAX_CONCURRENT_WAITS_PER_INBOX: "",
                MAX_WEBHOOK_TESTS_PER_DAY: "",
                // Features of the parity build: defaults apply unless a test sets them.
                MAX_FEED_EVENTS_PER_DAY: "",
                MAX_LIST_ENTRIES_PER_ACCOUNT: "",
                MAX_INBOX_CLEARS_PER_DAY: "",
                MAX_SCHEDULED_PER_ACCOUNT: "",
                MAX_ATTACHMENT_TEXT_PER_DAY: "",
                // Delivery tracking off, as in the generic template; its tests turn it on.
                DELIVERY_EVENTS_QUEUE: "",
                ...Object.fromEntries(
                  [
                    "SEND_DAILY_LIMIT",
                    "MAX_INBOXES_PER_ACCOUNT",
                    "MAX_INBOX_CREATES_PER_DAY",
                    "MAX_INBOX_DELETES_PER_DAY",
                    "MAX_MESSAGES_PER_INBOX",
                    "MAX_INBOUND_PER_ACCOUNT_PER_DAY",
                    "MAX_INBOUND_PER_SENDER_PER_DAY",
                    "MAX_TEXT_BYTES_PER_ACCOUNT",
                    "MAX_BLOB_BYTES_PER_ACCOUNT",
                    "MAX_CONCURRENT_WAITS",
                    "MAX_CONCURRENT_WAITS_PER_INBOX",
                    "MAX_WEBHOOKS_PER_ACCOUNT",
                    "MAX_WEBHOOK_TESTS_PER_DAY",
                    "MAX_FEED_EVENTS_PER_DAY",
                    "MAX_LIST_ENTRIES_PER_ACCOUNT",
                    "MAX_INBOX_CLEARS_PER_DAY",
                    "MAX_SCHEDULED_PER_ACCOUNT",
                    "MAX_ATTACHMENT_TEXT_PER_DAY",
                  ].map((n) => [`UNCLAIMED_${n}`, ""]),
                ),
              },
            },
          })),
        ],
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: ["./test/integration/apply-migrations.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
