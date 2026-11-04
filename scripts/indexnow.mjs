#!/usr/bin/env node
/**
 * Tells IndexNow (Bing, Yandex, Seznam, Naver and others) about every URL in the sitemap, so new
 * and changed pages are crawled without waiting. Run after a deploy that changes pages:
 *
 *   node scripts/indexnow.mjs
 *
 * The key is the name of the one 32-hex-character .txt file in site/public (its content is the
 * same key); IndexNow fetches it to prove we own the host.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "site", "public");
const HOST = "agentfirststack.com";

const keyFile = readdirSync(PUBLIC).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) throw new Error("No IndexNow key file (32 hex characters + .txt) in site/public");
const key = keyFile.slice(0, -4);
const urls = [...readFileSync(join(PUBLIC, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key, keyLocation: `https://${HOST}/${keyFile}`, urlList: urls }),
});
console.log(`IndexNow: ${res.status} ${res.statusText} for ${urls.length} URLs`);
if (res.status >= 400) {
  console.log(await res.text());
  process.exit(1);
}
