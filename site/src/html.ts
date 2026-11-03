import { ApiError } from "@afs/shared";
import type { ErrorHandler } from "hono";
import type { Session, SiteEnv } from "./env";

/**
 * Server-rendered HTML for the human pages (sign-in, claim, dashboard, consent). Everything
 * interpolated into `html```  is escaped unless it is itself an `html``` fragment, so a value can
 * only become markup by being written as markup here. Pages ship no JavaScript.
 */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? "");
  return new SafeHtml(out);
}

/** "3 Nov 2026, 14:05 UTC" */
export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "never";
  const d = new Date(ms);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${hm} UTC`;
}

export const csrfField = (s: Session) => html`<input type="hidden" name="csrf" value="${s.csrf}">`;

const BRAND = html`<a class="brand" href="/" aria-label="AgentFirstStack home">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="5" height="14" rx="1.5" fill="#FF6A2B"/><rect x="9.5" y="5" width="5" height="14" rx="1.5" fill="#F4B400"/><rect x="17" y="5" width="5" height="14" rx="1.5" fill="#2F6BFF"/></svg>
      <span>AgentFirstStack</span>
    </a>`;

function nav(session: Session | null | undefined) {
  if (!session) return html`<nav class="nav-links" aria-label="Main"><a href="/llms.txt">Manual</a><a href="/signin">Sign in</a></nav>`;
  return html`<nav class="nav-links" aria-label="Main">
      <a href="/dashboard">Projects</a>
      <a href="/dashboard/apps">Connected apps</a>
      <a href="/dashboard/account">Account</a>
      <form method="post" action="/auth/signout" class="nav-form">${csrfField(session)}<button type="submit" class="link-button">Sign out</button></form>
    </nav>`;
}

export interface PageOptions {
  title: string;
  body: SafeHtml;
  session?: Session | null;
  status?: number;
  /**
   * The consent page posts to itself and then redirects to the client's redirect_uri, which a
   * `form-action 'self'` policy would block in some browsers. Everything else keeps it.
   */
  allowExternalFormRedirect?: boolean;
  /** Extra response headers (e.g. Set-Cookie). */
  headers?: HeadersInit;
}

export function pageHeaders(allowExternalFormRedirect = false): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": [
      "default-src 'none'",
      "style-src 'self'",
      "font-src 'self'",
      "img-src 'self' data:",
      ...(allowExternalFormRedirect ? [] : ["form-action 'self'"]),
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-frame-options": "DENY",
    // same-origin, not no-referrer: with no-referrer browsers send `Origin: null` on our own form
    // posts. Claim tokens in URLs still never leak to other sites.
    "referrer-policy": "same-origin",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  };
}

export function page(opts: PageOptions): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · AgentFirstStack</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/dashboard.css">
</head>
<body class="app">
<header class="nav is-scrolled">
  <div class="wrap nav-inner">
    ${BRAND}
    ${nav(opts.session)}
  </div>
</header>
<main class="wrap app-main">
${opts.body}
</main>
<footer class="footer">
  <div class="wrap footer-inner">
    <p>Made by <a href="https://startglobal.co">StartGlobal</a>. MIT licensed.</p>
    <p class="footer-links"><a href="/llms.txt">Manual</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="https://github.com/StartGlobal-AI/agentfirststack">GitHub</a></p>
  </div>
</footer>
</body>
</html>
`;
  const headers = new Headers(pageHeaders(opts.allowExternalFormRedirect));
  if (opts.headers) new Headers(opts.headers).forEach((v, k) => headers.append(k, v));
  return new Response(doc.value, { status: opts.status ?? 200, headers });
}

/** A plain message page (errors, "link expired", "signed out"). */
export function messagePage(opts: {
  title: string;
  message: string;
  status?: number;
  session?: Session | null;
  action?: { href: string; label: string };
}): Response {
  return page({
    title: opts.title,
    status: opts.status,
    session: opts.session,
    body: html`<section class="narrow">
  <h1>${opts.title}</h1>
  <p class="lead">${opts.message}</p>
  ${opts.action ? html`<p class="actions"><a class="btn btn-primary" href="${opts.action.href}">${opts.action.label}</a></p>` : ""}
</section>`,
  });
}

/** onError for the people-facing sub-apps: errors become pages, not JSON. */
export const htmlErrorHandler: ErrorHandler<SiteEnv> = (err, c) => {
  const session = c.get("session");
  if (err instanceof ApiError) {
    return messagePage({
      title: err.status === 404 ? "Not found" : "That didn't work",
      message: [err.message, err.hint].filter(Boolean).join(" "),
      status: err.status,
      session,
      action: session ? { href: "/dashboard", label: "Back to your projects" } : { href: "/", label: "Home" },
    });
  }
  console.error("page error", err);
  return messagePage({ title: "Something went wrong", message: "Please try again in a moment.", status: 500, session });
};
