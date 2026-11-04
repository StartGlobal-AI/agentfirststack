/**
 * Browser runtime for /c/:id.js. Bundled by esbuild (scripts/build-runtime.mjs) into
 * dist/runtime.txt; the Worker serves `(function(){var __AFST__={...config};<this bundle>})()`.
 * Containers using video triggers, wait_for_tags_ms, cross-domain linking or TCF get
 * dist/runtime-ext.txt instead (index-ext.ts: this plus src/runtime/ext.ts).
 */
import { boot } from "./boot";

boot();
