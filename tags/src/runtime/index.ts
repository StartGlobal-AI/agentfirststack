/**
 * Browser runtime for /c/:id.js. Bundled by esbuild (scripts/build-runtime.mjs) into
 * dist/runtime.txt; the Worker serves `(function(){var __AFST__={...config};<this bundle>})()`.
 */
import { Runtime } from "./core";
import type { BootConfig } from "./types";

declare const __AFST__: BootConfig | undefined;

(function () {
  try {
    const boot = typeof __AFST__ !== "undefined" ? __AFST__ : undefined;
    if (!boot || typeof window === "undefined") return;
    new Runtime(window, document, boot).start();
  } catch (e) {
    try {
      console.error("[afst] runtime error", e);
    } catch {
      /* ignore */
    }
  }
})();
