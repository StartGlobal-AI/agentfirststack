#!/usr/bin/env node
/**
 * Writes site/public/sitemap.xml from the pages in site/public: every *.html file (served
 * without its extension; index.html is "/"), plus the plain-text manuals. lastmod is the
 * file's last git commit date (or today when it isn't committed yet).
 *
 *   node scripts/sitemap.mjs            # write it
 *   node scripts/sitemap.mjs --urls     # print the URLs (for IndexNow)
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "site", "public");
const ORIGIN = "https://agentfirststack.com";
/** Pages that exist but shouldn't be in the sitemap. */
const SKIP = new Set([]);
const EXTRA = ["llms.txt", "auth.md"];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith(".") || name === "og" || name === "fonts" || name === "brand") return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const today = new Date().toISOString().slice(0, 10);
function lastmod(file) {
  try {
    const d = execFileSync("git", ["log", "-1", "--format=%cs", "--", file], { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", file], { cwd: ROOT, encoding: "utf8" }).trim();
    return dirty || !d ? today : d;
  } catch {
    return today;
  }
}

const pages = walk(PUBLIC)
  .filter((f) => f.endsWith(".html"))
  .map((f) => relative(PUBLIC, f))
  .filter((rel) => !SKIP.has(rel))
  .map((rel) => ({ rel, path: rel === "index.html" ? "/" : `/${rel.replace(/\.html$/, "")}` }));
for (const rel of EXTRA) pages.push({ rel, path: `/${rel}` });

const LEGAL = /^\/(privacy|terms|acceptable-use)$/;
const priority = (path) => (path === "/" ? "1.0" : path === "/guides" || path === "/llms.txt" ? "0.9" : LEGAL.test(path) ? "0.3" : "0.8");
const changefreq = (path) => (LEGAL.test(path) ? "yearly" : "weekly");

pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));

if (process.argv.includes("--urls")) {
  for (const p of pages) console.log(ORIGIN + p.path);
} else {
  const body = pages
    .map(
      (p) =>
        `  <url><loc>${ORIGIN}${p.path}</loc><lastmod>${lastmod(join(PUBLIC, p.rel))}</lastmod><changefreq>${changefreq(p.path)}</changefreq><priority>${priority(p.path)}</priority></url>`,
    )
    .join("\n");
  writeFileSync(
    join(PUBLIC, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
  );
  console.log(`sitemap.xml: ${pages.length} URLs`);
}
