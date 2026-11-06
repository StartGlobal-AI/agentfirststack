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
        : id.endsWith("dist/consent-ui.txt")
          ? await bundleRuntime({ banner: true })
          : readFileSync(id, "utf8");
    return `export default ${JSON.stringify(text)};`;
  },
};

/** Internal auth between this test Worker and the analytics stand-in (obviously fake). */
const INTERNAL_TOKEN = "test-internal-token";

/**
 * A stand-in for the analytics Worker behind the ANALYTICS service binding. Like analytics, it
 * accepts internal auth only on https://<svc>.internal URLs with the right token, and a site only
 * for the account that owns it: tests register sites (PUT /__test/sites/:id, x-afs-account) and
 * read back what reached it (GET /__test/requests).
 */
const analyticsSites = new Map<string, string>();
const analyticsRequests: { method: string; url: string; account: string | null; auth: boolean; body: unknown }[] = [];
async function analyticsStub(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const account = req.headers.get("x-afs-account");
  if (u.pathname.startsWith("/__test/sites/")) {
    analyticsSites.set(u.pathname.slice("/__test/sites/".length), account ?? "");
    return json({ ok: true });
  }
  if (u.pathname === "/__test/requests") return json({ requests: analyticsRequests });
  const text = req.method === "GET" ? "" : await req.text();
  const internal = u.hostname.endsWith(".internal") && req.headers.get("x-afs-internal") === INTERNAL_TOKEN;
  analyticsRequests.push({
    method: req.method,
    url: req.url,
    account,
    auth: !!req.headers.get("authorization"),
    body: text ? JSON.parse(text) : null,
  });
  if (!internal) return json({ error: { code: "unauthorized" } }, 401);
  const m = /^\/v1\/sites\/([a-z0-9_]+)(\/events)?$/.exec(u.pathname);
  if (!m || !account || analyticsSites.get(m[1]!) !== account)
    return json({ error: { code: "not_found", message: "Site not found." } }, 404);
  if (!m[2]) return json({ site: { id: m[1], domain: "analytics.test" } });
  return json({ accepted: ((JSON.parse(text) as { events?: unknown[] }).events ?? []).length }, 202);
}

/**
 * A stand-in for the site Worker behind the SITE service binding: it records capability pause
 * requests (GET /__test/pauses) and answers 503, so requestCapabilityPause falls back to writing
 * the pause into AUTH_DB itself (what the tests then read back).
 */
const pauseRequests: { url: string; internal: boolean; account: string | null; body: unknown }[] = [];
async function siteStub(req: Request): Promise<Response> {
  const u = new URL(req.url);
  if (u.pathname === "/__test/pauses") return Response.json({ requests: pauseRequests });
  const text = req.method === "GET" ? "" : await req.text();
  pauseRequests.push({
    url: req.url,
    internal: u.hostname === "site.internal" && req.headers.get("x-afs-internal") === INTERNAL_TOKEN,
    account: req.headers.get("x-afs-account"),
    body: text ? JSON.parse(text) : null,
  });
  return Response.json({ error: { code: "unavailable" } }, { status: 503 });
}

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
              serviceBindings: { ANALYTICS: analyticsStub, SITE: siteStub },
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
                  ["READ_LIMITER", "42018"],
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
                MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY: "",
                UNCLAIMED_MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY: "",
                MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY: "",
                UNCLAIMED_MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY: "",
                SPIKE_MIN_EVENTS: "",
                SPIKE_MIN_NETWORKS: "",
                MAX_SCANS_PER_ACCOUNT_PER_DAY: "",
                UNCLAIMED_MAX_SCANS_PER_ACCOUNT_PER_DAY: "",
                MAX_SCANS_PER_DAY: "",
                MAX_DESTINATION_TESTS_PER_ACCOUNT_PER_DAY: "",
                UNCLAIMED_MAX_DESTINATION_TESTS_PER_ACCOUNT_PER_DAY: "",
                MAX_DESTINATION_TESTS_PER_DAY: "",
                EXTRA_BLOCKED_CODE_HOSTS: "",
                MAX_VISITORS_PER_CONTAINER: "",
                MAX_CONTAINER_DB_BYTES: "",
                MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY: "",
                UNCLAIMED_MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY: "",
                CIRCUIT_BREAKER_FAILURES: "",
                CIRCUIT_BREAKER_MINUTES: "",
                ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                INTERNAL_TOKEN,
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
