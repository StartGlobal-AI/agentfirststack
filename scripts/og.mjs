#!/usr/bin/env node
/**
 * Social preview cards (1200x630 PNG) for the site's pages, rendered from HTML with headless
 * Chrome so they use the site's own fonts and colours.
 *
 *   node scripts/og.mjs <slug> "<title>" ["<kicker>"] [analytics|tags|mail|replay|all]
 *   node scripts/og.mjs --all          # every card listed in site/og-cards.json
 *
 * Writes site/public/og/<slug>.png. Needs Google Chrome (CHROME=/path/to/chrome to override).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "site", "public");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Blue only, like the marketing pages: each service a shade of it.
const COLORS = { analytics: "#2F6BFF", tags: "#1A3FD6", mail: "#5B8CFF", replay: "#9CC2FF" };

/** A corner of pixels, the landing page's motif: a fixed pattern so every card looks the same. */
function pixels() {
  const blues = ["#12298A", "#1A3FD6", "#2F6BFF", "#5B8CFF", "#9CC2FF", "#7FD4FF"];
  let out = "";
  for (let r = 0; r < 11; r++)
    for (let c = 0; c < 16; c++) {
      const v = Math.max(0, 1 - Math.hypot((15 - c) / 15, r / 10.5)) * 1.25;
      const t = ((r * 7 + c * 13) % 16) / 16;
      if (v < t * 0.9 || v < 0.08) continue;
      const b = blues[Math.min(blues.length - 1, Math.floor(v * blues.length))];
      out += `<i style="left:${c * 26}px;top:${r * 26}px;background:${b};opacity:${(0.25 + v * 0.6).toFixed(2)}"></i>`;
    }
  return `<div class="px">${out}</div>`;
}
const LABELS = { analytics: "Analytics", tags: "Tags", mail: "Mail", replay: "Replay" };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function html({ title, kicker, service }) {
  const services = service && service !== "all" ? [service] : Object.keys(COLORS);
  const fonts = pathToFileURL(join(PUBLIC, "fonts")).href;
  const size = title.length > 60 ? 64 : title.length > 40 ? 76 : 88;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Host Grotesk";src:url("${fonts}/host-grotesk.woff2") format("woff2");font-weight:300 800}
@font-face{font-family:"Geist Mono";src:url("${fonts}/geist-mono.woff2") format("woff2");font-weight:400 600}
*{margin:0;box-sizing:border-box}
html,body{width:1200px;height:630px}
body{background:linear-gradient(160deg,#040A2B 0%,#0A1A5C 100%);color:#fff;font-family:"Host Grotesk",sans-serif;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;position:relative}
.top{display:flex;align-items:center;gap:18px;font-size:30px;font-weight:650;letter-spacing:-.01em}
.mark{display:grid;grid-template-columns:repeat(2,17px);gap:4px}.mark i{display:block;width:17px;height:17px;border-radius:4px}
.px{position:absolute;right:0;top:0;width:416px;height:286px}.px i{position:absolute;width:22px;height:22px;border-radius:3px}
.top,h1,.kicker,.foot{position:relative;z-index:1}
h1{font-size:${size}px;line-height:1.04;font-weight:700;letter-spacing:-.035em;max-width:1000px}
.kicker{margin-top:26px;font-size:30px;line-height:1.35;color:#C9D8FF;max-width:960px}
.foot{display:flex;justify-content:space-between;align-items:flex-end}
.chips{display:flex;gap:14px}
.chip{display:flex;align-items:center;gap:10px;font-size:24px;font-weight:600;color:#E8F0FF;border:1px solid #2A3F8F;border-radius:6px;padding:10px 16px}
.chip b{width:14px;height:14px;border-radius:3px;display:block}
.url{font-family:"Geist Mono",monospace;font-size:24px;color:#9CC2FF}
.bar{position:absolute;left:0;right:0;bottom:0;height:10px;display:flex}.bar i{flex:1}
</style></head><body>
${pixels()}
<div class="top"><span class="mark"><i style="background:#5B8CFF"></i><i style="background:#9CC2FF"></i><i style="background:#1A3FD6"></i><i style="background:#2F6BFF"></i></span>AgentFirstStack</div>
<div><h1>${esc(title)}</h1>${kicker ? `<p class="kicker">${esc(kicker)}</p>` : ""}</div>
<div class="foot"><div class="chips">${services.map((s) => `<span class="chip"><b style="background:${COLORS[s]}"></b>${LABELS[s]}</span>`).join("")}</div><span class="url">agentfirststack.com</span></div>
<div class="bar">${services.map((s) => `<i style="background:${COLORS[s]}"></i>`).join("")}</div>
</body></html>`;
}

function render(card) {
  if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9-]+)*$/.test(card.slug)) throw new Error(`bad slug: ${card.slug}`);
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME=...)`);
  const dir = mkdtempSync(join(tmpdir(), "afs-og-"));
  try {
    const page = join(dir, "card.html");
    writeFileSync(page, html(card));
    const out = join(PUBLIC, "og", `${card.slug.replaceAll("/", "-")}.png`);
    mkdirSync(dirname(out), { recursive: true });
    execFileSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--window-size=1200,630",
        `--user-data-dir=${join(dir, "profile")}`,
        `--screenshot=${out}`,
        pathToFileURL(page).href,
      ],
      { stdio: "ignore" },
    );
    console.log(`og/${card.slug.replaceAll("/", "-")}.png`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === "--all") {
  for (const card of JSON.parse(readFileSync(join(ROOT, "site", "og-cards.json"), "utf8"))) render(card);
} else if (args.length >= 2) {
  render({ slug: args[0], title: args[1], kicker: args[2] ?? "", service: args[3] ?? "all" });
} else {
  console.error('usage: node scripts/og.mjs <slug> "<title>" ["<kicker>"] [analytics|tags|mail|replay|all] | --all');
  process.exit(1);
}
