// Bundles the browser runtime (src/runtime) into dist/runtime.txt (core), dist/runtime-ext.txt
// (core + optional features) and dist/consent-ui.txt (the consent banner UI, its own script),
// imported by the Worker as Text modules. Run by wrangler's build.command before dev/deploy; tests
// call bundleRuntime().
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {{ minify?: boolean, ext?: boolean, banner?: boolean }} [opts] */
export async function bundleRuntime({ minify = true, ext = false, banner = false } = {}) {
  const entry = banner ? "src/runtime/index-banner.ts" : ext ? "src/runtime/index-ext.ts" : "src/runtime/index.ts";
  const r = await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    minify,
    format: "iife",
    target: ["es2017"],
    platform: "browser",
    tsconfig: resolve(root, "src/runtime/tsconfig.json"),
    legalComments: "none",
    write: false,
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [file, opts] of [
    ["runtime.txt", {}],
    ["runtime-ext.txt", { ext: true }],
    ["consent-ui.txt", { banner: true }],
  ]) {
    const js = await bundleRuntime(opts);
    const out = resolve(root, "dist", file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, js);
    console.log(`runtime: ${(js.length / 1024).toFixed(1)} KB -> dist/${file}`);
  }
}
