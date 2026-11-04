import { Runtime } from "./core";
import type { BootConfig } from "./types";

declare const __AFST__: BootConfig | undefined;

/** Start the runtime with the config the Worker inlined as __AFST__ (see src/service/script.ts). */
export function boot() {
  try {
    const cfg = typeof __AFST__ !== "undefined" ? __AFST__ : undefined;
    if (!cfg || typeof window === "undefined") return;
    new Runtime(window, document, cfg).start();
  } catch (e) {
    try {
      console.error("[afst] runtime error", e);
    } catch {
      /* ignore */
    }
  }
}
