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

/** "3 Nov 2026" */
export function fmtDay(ms: number | null | undefined): string {
  return ms ? fmtDate(ms).split(",")[0]! : "never";
}

/** 1284 -> "1,284" */
export const fmtNum = (n: number) => new Intl.NumberFormat("en-US").format(n);

/** The three bars of the AgentFirstStack mark: analytics, tags, mail. */
export const MARK = html`<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="5" height="14" rx="1.5" fill="#FF6A2B"/><rect x="9.5" y="5" width="5" height="14" rx="1.5" fill="#F4B400"/><rect x="17" y="5" width="5" height="14" rx="1.5" fill="#2F6BFF"/></svg>`;

const BRAND = html`<a class="brand" href="/" aria-label="AgentFirstStack home">${MARK}<span>AgentFirstStack</span></a>`;

/**
 * "Sign in with Google" as Google's branding guidelines draw it (light theme, rectangular): white
 * fill, 1px #747775 stroke, #1F1F1F Google Sans Medium 14/20, the standard-colour "G" at 20px,
 * 12px / 10px / 12px padding, 40px high. Styles in dashboard.css (.gsi).
 */
export const googleButton = (href: string, label: "Sign in with Google" | "Continue with Google" = "Sign in with Google") =>
  html`<a class="gsi" href="${href}"><img class="gsi-logo" src="/google-g.svg" width="20" height="20" alt=""><span class="gsi-label">${label}</span></a>`;

export type NavItem = "projects" | "apps" | "account";

function topbar(session: Session | null | undefined, active?: NavItem) {
  if (!session) {
    return html`<header class="topbar">
  <div class="shell topbar-inner">
    ${BRAND}
    <nav class="topbar-end topbar-links" aria-label="Main"><a href="/llms.txt">Manual</a><a href="/signin">Sign in</a></nav>
  </div>
</header>`;
  }
  const item = (key: NavItem, href: string, label: string) =>
    html`<a href="${href}"${key === active ? html` aria-current="page"` : ""}>${label}</a>`;
  return html`<header class="topbar">
  <div class="shell topbar-inner">
    ${BRAND}
    <nav class="topnav" aria-label="Main">
      ${item("projects", "/dashboard", "Projects")}
      ${item("apps", "/dashboard/apps", "Connected apps")}
      ${item("account", "/dashboard/account", "Account")}
    </nav>
    <div class="topbar-end">
      <span class="topbar-user">${session.user.email}</span>
      <form method="post" action="/auth/signout" class="nav-form">${csrfField(session)}<button type="submit" class="btn btn-quiet btn-small">Sign out</button></form>
    </div>
  </div>
</header>`;
}

export interface PageOptions {
  title: string;
  body: SafeHtml;
  session?: Session | null;
  /** Which top-bar item is the current page. */
  nav?: NavItem;
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
<meta name="theme-color" content="#FFFFFF">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/host-grotesk.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/dashboard.css">
</head>
<body class="app">
<a class="skip" href="#main">Skip to content</a>
${topbar(opts.session, opts.nav)}
<main class="shell app-main" id="main">
${opts.body}
</main>
<footer class="footer">
  <div class="shell footer-inner">
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
    body: html`<section class="solo">
  <div class="tile solo-card">
    <span class="solo-mark">${MARK}</span>
    <h1>${opts.title}</h1>
    <p class="lead">${opts.message}</p>
    ${opts.action ? html`<p class="row"><a class="btn btn-primary" href="${opts.action.href}">${opts.action.label}</a></p>` : ""}
  </div>
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
