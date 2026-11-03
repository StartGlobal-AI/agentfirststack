import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";
import { bundleRuntime } from "./scripts/build-runtime.mjs";

/** Text modules (wrangler `rules`) for Vite: dist/runtime.txt is bundled on the fly. */
const textModules: Plugin = {
  name: "afs-text-modules",
  enforce: "pre",
  async load(id) {
    if (!id.endsWith(".txt")) return null;
    const text = id.endsWith("dist/runtime.txt") ? await bundleRuntime() : readFileSync(id, "utf8");
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
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
                // The shared identity DB (AUTH_DB), as on the hosted platform.
                TEST_AUTH_MIGRATIONS: await readD1Migrations("../site/migrations"),
                // Fair-use controls stay off in tests (deployments may turn them on).
                PUBLIC_BASE_URL: "",
                ANALYTICS_BASE_URL: "",
                SIGNUP_HOURLY_LIMIT: "0",
                MAX_CONTAINERS_PER_ACCOUNT: "",
                ENCRYPTION_KEY: "q0n3d6Vf1w8Hq7m4Zt2yXb9cLr5sKp1uJe6aNg3hTiY=",
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
