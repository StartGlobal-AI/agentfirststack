/**
 * The HTML shell of /play/<token>. No inline script: the player bundle is a same-origin asset and
 * the CSP allows nothing else. Recorded pages are rebuilt by rrweb in a sandboxed iframe; their
 * images, fonts and stylesheets load only from the recorded site's own hosts (its domain, its
 * subdomains, allowed_hostnames), never scripts, so a forged recording can't pull content from
 * anywhere onto this domain.
 */

/** CSP for a player page; `hosts` are CSP host sources of the recorded site ("https://example.com", "https://*.example.com"). */
export function playerCsp(hosts: readonly string[]): string {
  const h = hosts.length ? ` ${hosts.join(" ")}` : "";
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline'${h}`,
    `img-src 'self' data: blob:${h}`,
    `font-src data:${h}`,
    `media-src blob:${h}`,
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "child-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const PLAYER_CSP = playerCsp([]);

export const playerHeaders = (hosts: readonly string[]) => ({
  "content-security-policy": playerCsp(hosts),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "private, no-store",
});

export const PLAYER_HEADERS = playerHeaders([]);

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
#status{padding:12px 24px;color:var(--muted)}footer{padding:0 24px 24px}#abuse{color:var(--muted);font-size:12px}#abuse a{color:inherit}
#banner{margin-top:8px;padding:8px 12px;border:1px solid var(--accent);border-radius:6px;color:var(--accent);font-weight:600}
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The platform's abuse form for this page, or null when this service runs without the platform site. */
export function reportAbuseUrl(platform: string | null, pageUrl: string): string | null {
  return platform ? `${platform}/report-abuse?url=${encodeURIComponent(pageUrl)}` : null;
}

const abuseLink = (href: string | null) =>
  href
    ? `<p id="abuse"><a href="${esc(href)}" rel="nofollow noopener noreferrer" target="_blank">Report abuse</a> (phishing, malware, someone else's content)</p>`
    : "";

export function playerPage(assets: { js: string; css: string }, abuseHref: string | null = null): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Session replay · AgentFirstStack Replay</title>
<link rel="stylesheet" href="${assets.css}"><style>${STYLE}</style>
<script defer src="${assets.js}"></script></head>
<body><header><h1 id="title">Session replay</h1><div id="meta"></div><div id="banner" hidden></div></header>
<div id="status">Loading…</div>
<main><div id="player"></div><aside><h2>Timeline</h2><ul id="timeline"></ul></aside></main>
<footer><div id="expires"></div>${abuseLink(abuseHref)}</footer></body></html>`;
}

/** A share link of a project whose share links are paused (capability replay.share_links). */
export function pausedPage(abuseHref: string | null = null): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Link unavailable</title><style>${STYLE}</style></head>
<body><header><h1>This replay link isn't available.</h1><div id="meta">Share links of this project are paused while it is reviewed.</div></header><footer>${abuseLink(abuseHref)}</footer></body></html>`;
}

export function expiredPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Link expired</title><style>${STYLE}</style></head>
<body><header><h1>This replay link has expired or was revoked.</h1><div id="meta">Ask whoever shared it for a new one.</div></header></body></html>`;
}
