/**
 * The HTML shell of /play/<token>. No inline script: the player bundle is a same-origin asset and
 * the CSP allows nothing else. Recorded pages are rebuilt by rrweb in a sandboxed iframe; their
 * images, fonts and stylesheets load from the recorded site (https:), never scripts.
 */

export const PLAYER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' https: data: blob:",
  "font-src https: data:",
  "media-src https: blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "child-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const PLAYER_HEADERS = {
  "content-security-policy": PLAYER_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "private, no-store",
};

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--bg:#fbfbfd;--card:#fff;--accent:#b4232a}
@media (prefers-color-scheme:dark){:root{--fg:#f2f2f7;--muted:#a1a1a6;--line:#2c2c2e;--bg:#111113;--card:#1c1c1e}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
header{padding:16px 24px;border-bottom:1px solid var(--line)}h1{font-size:16px;margin:0 0 4px}#meta,#expires{color:var(--muted);font-size:13px}
main{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;padding:16px 24px}@media (max-width:1100px){main{grid-template-columns:1fr}}
#player{background:var(--card);border:1px solid var(--line);border-radius:8px;min-height:200px;overflow:hidden}
aside{background:var(--card);border:1px solid var(--line);border-radius:8px;max-height:80vh;overflow:auto}
aside h2{font-size:13px;margin:0;padding:10px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card)}
ul{list-style:none;margin:0;padding:0}li{display:grid;grid-template-columns:52px 52px 1fr;gap:6px;padding:6px 12px;border-bottom:1px solid var(--line);font-size:12px}
li button{font:inherit;font-variant-numeric:tabular-nums;border:0;background:none;color:var(--fg);cursor:pointer;text-align:left;padding:0;text-decoration:underline dotted}
.kind{color:var(--muted)}.text{overflow-wrap:anywhere}.signals{grid-column:3;color:var(--accent);font-weight:600}li.sig{background:color-mix(in srgb,var(--accent) 6%,transparent)}
#status{padding:12px 24px;color:var(--muted)}footer{padding:0 24px 24px}
`;

export function playerPage(assets: { js: string; css: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Session replay · AgentFirstStack Replay</title>
<link rel="stylesheet" href="${assets.css}"><style>${STYLE}</style>
<script defer src="${assets.js}"></script></head>
<body><header><h1 id="title">Session replay</h1><div id="meta"></div></header>
<div id="status">Loading…</div>
<main><div id="player"></div><aside><h2>Timeline</h2><ul id="timeline"></ul></aside></main>
<footer id="expires"></footer></body></html>`;
}

export function expiredPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Link expired</title><style>${STYLE}</style></head>
<body><header><h1>This replay link has expired or was revoked.</h1><div id="meta">Ask whoever shared it for a new one.</div></header></body></html>`;
}
