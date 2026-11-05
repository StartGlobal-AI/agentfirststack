#!/usr/bin/env node
/**
 * Keeps the site's MCP tool lists and counts in step with the apps' src/mcp.ts.
 *
 *   node scripts/tool-counts.mjs          rewrite the files below
 *   node scripts/tool-counts.mjs --check  exit 1 if any of them is out of date
 *
 * Reads every t.read("name", ...) / t.write("name", ...) registration, then updates:
 *   site/public/mcp.html                     "<Service> (N tools)" headings, the Read / Write lists, the gateway count,
 *                                            the servers table (per service, and the gateway's total and own tools)
 *   site/public/llms.txt                     the gateway total and its own tools in the MCP section
 *   site/public/.well-known/mcp/*.json       toolCount (server-card.json is the gateway total)
 *   site/public/gmail-mcp.html               "all N tools" in the mail manual sentence
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = ["analytics", "tags", "mail", "replay"];
const check = process.argv.includes("--check");

const tools = {};
for (const app of APPS) {
  const src = readFileSync(join(root, app, "src/mcp.ts"), "utf8");
  const read = [];
  const write = [];
  for (const m of src.matchAll(/\bt\.(read|write)\(\s*"([a-z0-9_]+)"/g)) (m[1] === "read" ? read : write).push(m[2]);
  if (!read.length) throw new Error(`${app}: no tools found in src/mcp.ts`);
  tools[app] = { read, write, count: read.length + write.length };
}
const total = APPS.reduce((n, a) => n + tools[a].count, 0);
// The gateway's own tools (not forwarded to a service), e.g. afs_create_claim_link.
const gateway = [...readFileSync(join(root, "site/src/mcp-gateway.ts"), "utf8").matchAll(/\bname: "(afs_[a-z0-9_]+)"/g)].map((m) => m[1]);

const edits = [];
function edit(rel, fn) {
  const path = join(root, rel);
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after !== before) edits.push({ rel, path, after });
}
const code = (names) => names.map((n) => `<code>${n}</code>`).join(", ");
/** ["a", "b", "c"] -> "a, b and c" */
const andList = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const must = (s, re, what) => {
  if (!re.test(s)) throw new Error(`not found: ${what}`);
  return s;
};

edit("site/public/mcp.html", (s) => {
  for (const app of APPS) {
    const t = tools[app];
    const head = new RegExp(`(<h3 id="${app}-tools">[A-Za-z]+ \\()\\d+( tools\\)</h3>)`);
    must(s, head, `${app} heading in mcp.html`);
    s = s.replace(head, `$1${t.count}$2`);
    // The Read and Write paragraphs follow the heading and its description, in that order.
    const block = new RegExp(`(<h3 id="${app}-tools">[\\s\\S]*?<p><b>Read:</b> )[^\\n]*?(\\.</p>\\n<p><b>Write:</b> )[^\\n]*?(\\.</p>)`);
    must(s, block, `${app} Read/Write lists in mcp.html`);
    s = s.replace(block, `$1${code(t.read)}$2${code(t.write)}$3`);
  }
  const labels = { analytics: "Analytics", tags: "Tags", mail: "Mail", replay: "Replay" };
  for (const app of APPS) {
    const row = new RegExp(`(<tr><th scope="row">${labels[app]}</th><td>)\\d+(</td>)`);
    must(s, row, `${app} row in the mcp.html servers table`);
    s = s.replace(row, `$1${tools[app].count}$2`);
  }
  const all =
    /(<tr><th scope="row">All services<\/th><td>)\d+(, prefixed <code>analytics_<\/code>, <code>tags_<\/code>, <code>mail_<\/code> or <code>replay_<\/code>, plus )[^<]*(?:<code>afs_[a-z_]+<\/code>(?:, | and )?)+(<\/td>)/;
  must(s, all, "All services row in the mcp.html servers table");
  s = s.replace(all, `$1${total}$2${andList(gateway.map((n) => `<code>${n}</code>`))}$3`);
  const gw = /(<h3 id="gateway-tools">Gateway \()\d+ tools?(\)<\/h3>)/;
  must(s, gw, "gateway heading in mcp.html");
  s = s.replace(gw, `$1${gateway.length} tool${gateway.length === 1 ? "" : "s"}$2`);
  return s;
});
edit("site/public/llms.txt", (s) => {
  const re = /One MCP server for every service \(\d+ tools: \d+ prefixed/;
  must(s, re, "gateway total in llms.txt");
  s = s.replace(re, `One MCP server for every service (${total + gateway.length} tools: ${total} prefixed`);
  const own = /(plus the gateway's own )(?:`afs_[a-z_]+`(?:, | and )?)+(\):)/;
  must(s, own, "gateway's own tools in llms.txt");
  return s.replace(own, `$1${andList(gateway.map((n) => `\`${n}\``))}$2`);
});
for (const app of [...APPS, "server-card"]) {
  edit(`site/public/.well-known/mcp/${app}.json`, (s) => {
    const re = /"toolCount": \d+/;
    must(s, re, `toolCount in ${app}.json`);
    // The server card is the gateway: every service's tools plus its own (what tools/list returns).
    return s.replace(re, `"toolCount": ${app === "server-card" ? total + gateway.length : tools[app].count}`);
  });
}
edit("site/public/gmail-mcp.html", (s) => {
  const re = /(mail manual<\/a> lists all )\d+( tools)/;
  must(s, re, "mail count in gmail-mcp.html");
  return s.replace(re, `$1${tools.mail.count}$2`);
});

const summary = `${APPS.map((a) => `${a} ${tools[a].count}`).join(", ")}; gateway ${total} + ${gateway.join(", ")}`;
if (check) {
  if (edits.length) {
    console.error(`Out of date (${summary}): ${edits.map((e) => e.rel).join(", ")}. Run: node scripts/tool-counts.mjs`);
    process.exit(1);
  }
  console.log(`Tool counts up to date: ${summary}`);
} else {
  for (const e of edits) writeFileSync(e.path, e.after);
  console.log(`${summary}\n${edits.length ? `Updated: ${edits.map((e) => e.rel).join(", ")}` : "Nothing to change."}`);
}
