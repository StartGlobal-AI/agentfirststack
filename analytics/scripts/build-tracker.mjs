// Bundles src/tracker/index.ts into dist/tracker.txt, which the Worker imports as a Text module
// (wrangler "rules") and serves at /s.js. Run by wrangler's build.command, and before tests.
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "dist/tracker.txt");
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, "src/tracker/index.ts")],
  outfile,
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  legalComments: "none",
  // verify_install looks for this marker to confirm a proxied /s.js really is the tracker.
  banner: { js: "/*! afs-analytics */" },
  logLevel: "warning",
});

const bytes = statSync(outfile).size;
const gz = gzipSync(readFileSync(outfile)).length;
console.log(`tracker: dist/tracker.txt ${bytes} B (${gz} B gzip)`);
