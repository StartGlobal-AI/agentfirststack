// Bundles src/tracker/index.ts into dist/tracker.txt, which the Worker imports as a Text module
// (wrangler "rules") and serves at /s.js. Run by wrangler's build.command, and before tests.
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Two builds of one source: /s.js (dist/tracker.txt) and /s.js?linker=1 (dist/tracker-linker.txt,
// with the cross-domain linker); __LINKER__ is a constant, so the default build drops that code.
for (const [file, linker] of [
  ["dist/tracker.txt", false],
  ["dist/tracker-linker.txt", true],
]) {
  const outfile = resolve(root, file);
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, "src/tracker/index.ts")],
    outfile,
    bundle: true,
    minify: true,
    format: "esm", // the source is its own IIFE (no imports or exports): no second wrapper, no "use strict"
    target: ["es2020"],
    legalComments: "none",
    define: { __LINKER__: String(linker) },
    // verify_install looks for this marker to confirm a proxied /s.js really is the tracker.
    banner: { js: "/*! afs-analytics */" },
    logLevel: "warning",
  });
  const bytes = statSync(outfile).size;
  const gz = gzipSync(readFileSync(outfile)).length;
  console.log(`tracker: ${file} ${bytes} B (${gz} B gzip)`);
}
