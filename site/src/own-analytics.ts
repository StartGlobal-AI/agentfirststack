import type { Context } from "hono";
import type { Bindings, SiteEnv } from "./env";
import { siteBase } from "./google";
import { callService } from "./services";

/**
 * The deployment's own analytics, for the conversions only this Worker sees: a project created
 * (POST /v1/signup here) and a project claimed (POST /claim/:token). They go as server events to
 * an analytics site of the deployment's own project, over the ANALYTICS service binding with
 * INTERNAL_TOKEN, so no API key is needed. Off unless OWN_ANALYTICS_ACCOUNT_ID and
 * OWN_ANALYTICS_SITE_ID are both set.
 *
 * What is sent: the event name, the project id the event is about (as user_id), the path and the
 * listed props. Never an email, name, Google id, claim token or key. A claim also passes the
 * request's IP and user agent so it joins the claimer's cookieless visit of the public pages
 * (analytics hashes them with a daily salt and stores neither); a browser that sends Global
 * Privacy Control or Do Not Track is not counted at all.
 */

export type OwnEventName = "signup" | "project_claimed";

export interface OwnEvent {
  name: OwnEventName;
  /** The project (acct_...) the event is about. Sent as user_id, so a claim joins its signup. */
  accountId: string;
  /** Path on this site the event happened at (never with a token in it). */
  path: string;
  props?: Record<string, string>;
  /** Join the visitor's own visit: send the request's IP and user agent. */
  visitor?: boolean;
}

const ACCOUNT = /^acct_[a-z0-9]+$/;
const SITE = /^site_[a-z0-9]+$/;

/** The configured target, or null when off (unset, or not an account / site id). */
export function ownAnalytics(env: Bindings): { account: string; site: string } | null {
  const account = env.OWN_ANALYTICS_ACCOUNT_ID?.trim();
  const site = env.OWN_ANALYTICS_SITE_ID?.trim();
  if (!account || !site || !ACCOUNT.test(account) || !SITE.test(site)) return null;
  return { account, site };
}

/** Send one event in the background. Never throws and never delays the response. */
export function trackOwn(c: Context<SiteEnv>, ev: OwnEvent): void {
  const target = ownAnalytics(c.env);
  if (!target) return;
  const h = c.req.raw.headers;
  if (h.get("sec-gpc") === "1" || h.get("dnt") === "1") return;
  const event: Record<string, unknown> = {
    name: ev.name,
    user_id: ev.accountId,
    url: new URL(ev.path, siteBase(c)).href,
  };
  if (ev.props) event.props = ev.props;
  // An agent signing up with curl isn't a visit: count the event, not a visitor or session.
  if (!ev.visitor) event.visit = false;
  if (ev.visitor) {
    const ip = h.get("cf-connecting-ip");
    const ua = h.get("user-agent");
    if (ip && ua) Object.assign(event, { ip, user_agent: ua });
  }
  const send = callService(c.env, "analytics", target.account, `/v1/sites/${target.site}/events`, {
    method: "POST",
    body: { events: [event] },
  })
    .then((r) => {
      if (!r.ok) console.warn(JSON.stringify({ event: "own_analytics.failed", name: ev.name, status: r.status }));
    })
    .catch(() => {});
  try {
    c.executionCtx.waitUntil(send);
  } catch {
    /* no execution context: the promise still runs */
  }
}

/**
 * AI crawlers and search bots don't run the tracker, so this Worker reports the bot requests it
 * serves (the public pages: not the API, the MCP gateway or the pages for people) to the same
 * analytics site, as POST /v1/sites/:id/crawls hits. Analytics classifies them by user agent
 * (unknown ones are ignored) and never counts them as visitors. Fire and forget: the page isn't
 * slowed down. The same prefilter idea as the analytics manual's "AI crawlers" middleware.
 */
const BOTS =
  /gptbot|oai-searchbot|chatgpt-user|claudebot|claude-user|claude-searchbot|anthropic-ai|perplexity|googlebot|google-extended|bingbot|applebot|ccbot|bytespider|amazonbot|meta-external|duckassistbot|mistralai|cohere|youbot|diffbot|bot\b|bot\/|crawl|spider|slurp/i;
const NOT_CONTENT = /^\/(?:v1|mcp|a2a|oauth|auth|dashboard|claim|signin)(?:\/|$)/;

export function trackCrawl(c: Context<SiteEnv>, status: number): void {
  const target = ownAnalytics(c.env);
  if (!target) return;
  const ua = c.req.header("user-agent") ?? "";
  if (!ua || !BOTS.test(ua)) return;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return;
  const path = new URL(c.req.url).pathname;
  if (NOT_CONTENT.test(path)) return;
  const send = callService(c.env, "analytics", target.account, `/v1/sites/${target.site}/crawls`, {
    method: "POST",
    body: { user_agent: ua.slice(0, 512), path, status },
  })
    .then((r) => {
      if (!r.ok) console.warn(JSON.stringify({ event: "own_crawls.failed", status: r.status }));
    })
    .catch(() => {});
  try {
    c.executionCtx.waitUntil(send);
  } catch {
    /* no execution context: the promise still runs */
  }
}
