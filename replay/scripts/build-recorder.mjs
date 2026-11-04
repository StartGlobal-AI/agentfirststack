// Bundles the browser code into Text modules the Worker imports (wrangler "rules") and serves:
//   dist/loader.txt     src/recorder/loader.ts    served at /r/<site_id>.js with the site config inlined
//   dist/recorder.txt   src/recorder/recorder.ts  rrweb record + our events, /recorder.<hash>.js
//   dist/player.txt     src/player/player.ts      rrweb-player, /assets/player-<hash>.js
//   dist/survey.txt     src/survey/widget.ts      survey widget, /sv/<site_id>.<rev>.js with the site's surveys inlined
//   dist/player-css.txt rrweb-player's stylesheet, /assets/player-<hash>.css
// Run by wrangler's build.command, and before tests.
import { build } from "esbuild";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
mkdirSync(dist, { recursive: true });

const common = { bundle: true, minify: true, format: "iife", target: ["es2020"], legalComments: "none", logLevel: "warning" };

await build({
  ...common,
  entryPoints: [resolve(root, "src/recorder/loader.ts")],
  outfile: resolve(dist, "loader.txt"),
});
await build({
  ...common,
  entryPoints: [resolve(root, "src/recorder/recorder.ts")],
  outfile: resolve(dist, "recorder.txt"),
  // verify_install and the tests look for this marker. rrweb is MIT (github.com/rrweb-io/rrweb).
  banner: { js: "/*! afs-replay recorder; includes rrweb record (MIT) */" },
});
await build({
  ...common,
  entryPoints: [resolve(root, "src/survey/widget.ts")],
  outfile: resolve(dist, "survey.txt"),
});
await build({
  ...common,
  entryPoints: [resolve(root, "src/player/player.ts")],
  outfile: resolve(dist, "player.txt"),
  banner: { js: "/*! afs-replay player; includes rrweb-player (MIT) */" },
});

const require = createRequire(import.meta.url);
// Only ./dist/style.css is exported; minify it with esbuild.
const cssPath = require.resolve("rrweb-player/dist/style.css");
const { outputFiles } = await build({
  entryPoints: [cssPath],
  bundle: false,
  minify: true,
  write: false,
  logLevel: "warning",
  loader: { ".css": "css" },
});
const css = outputFiles[0].text.replace(/\/\*# sourceMappingURL=.*?\*\//g, "");
writeFileSync(resolve(dist, "player-css.txt"), css);

for (const f of ["loader.txt", "recorder.txt", "survey.txt", "player.txt", "player-css.txt"]) {
  const p = resolve(dist, f);
  console.log(`replay: dist/${f} ${statSync(p).size} B (${gzipSync(readFileSync(p)).length} B gzip)`);
}
