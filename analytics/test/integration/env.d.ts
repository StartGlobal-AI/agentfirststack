/// <reference types="@cloudflare/vitest-plugin/types" />
import type { D1Migration } from "cloudflare:test";
import type { Bindings } from "../../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
      TEST_AUTH_MIGRATIONS: D1Migration[];
    }
  }
}
