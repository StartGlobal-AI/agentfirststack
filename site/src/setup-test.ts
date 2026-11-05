import { type AuthContext, badRequest, requireAuth, tooManyRequests } from "@afs/shared";
import { Hono } from "hono";
import type { Bindings, SiteEnv } from "./env";
import { siteBase } from "./google";
import { callService, projectResources, type Resources } from "./services";
import { normDomain, parseDomain, parseServices, type SetupService, serviceUrl } from "./setup-check";

/**
 * The setup test: sends real test traffic through every part of a project and checks it arrives.
 *
 * POST /v1/setup/test runs what can be tested from the server: a test email from the project's
 * inbox to itself (sent, received, code read back), analytics and replay `verify`, a test event
 * into analytics, a test event through the tag container to analytics, and a test conversion to
 * each ad platform (in the platform's test mode, or not sent where it has none). It returns a
 * browser plan built from the live tags config: the pages to open and the actions to take in a
 * real browser, as test traffic. GET /v1/setup/test?since= then checks that the visit arrived:
 * pageviews and each expected event in analytics and the tag manager, all flagged as test, and a
 * test replay recording.
 *
 * Test traffic stays out of the owner's numbers: analytics stores it as debug (purged after 7
 * days), tags sends it to ad platforms only in test mode, replay marks the session forced. The
 * test events never match a goal (`afs_test_*`), so they can't make a goal look verified.
 */

export type TestStatus = "passed" | "failed" | "skipped";
export interface SetupTest {
  id: string;
  service: "mail" | "analytics" | "tags" | "replay" | "browser";
  domain?: string;
  status: TestStatus;
  title: string;
  detail: string;
  fix?: string;
}
export interface BrowserStep {
  action: string;
  expect?: string[];
}
export interface BrowserPlan {
  domain: string;
  start_url: string;
  steps: BrowserStep[];
  expected_events: string[];
  not_in_browser: string[];
  check: string;
}
export interface TestRun {
  project: { id: string; name: string | null };
  started_at: number;
  finished_at: number;
  passed: boolean;
  summary: string;
  tests: SetupTest[];
  browser_plan?: BrowserPlan;
  next_steps: string[];
  report_markdown: string;
}

const TEST_TAG = "afs-test";
/** Event names no goal or conversion uses, so test events can't make a goal look verified. */
const ANALYTICS_TEST_EVENT = "afs_test_analytics";
const TAGS_TEST_EVENT = "afs_test_tags";
/** Realtime and the tags event log cover the last hour: the browser check must run within it. */
const BROWSER_WINDOW_MS = 60 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const list = (names: string[], max = 8) =>
  names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errOf = (json: unknown) => {
  const e = (json as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
  return e ? `${e.message ?? e.code ?? "error"}${e.hint ? ` ${e.hint}` : ""}` : "no answer";
};

interface Conversion {
  name: string;
  trigger?: string;
  send_to?: Record<string, unknown> & { analytics?: { event_name?: string } };
}
interface Trigger {
  id: string;
  type: string;
  selector?: string;
  event?: string;
  description?: string;
  conditions?: { var: string; op: string; value: unknown }[];
}
interface LiveConfig {
  conversions?: Conversion[];
  triggers?: Trigger[];
  tags?: { id: string; type: string; enabled?: boolean }[];
}
interface Goal {
  name: string;
  type: string;
  match: string;
}

type Svc = "analytics" | "tags" | "mail" | "replay";

interface Ctx {
  env: Bindings;
  accountId: string;
  base: string;
  has: Record<Svc, boolean>;
  call: <T>(svc: Svc, path: string, init?: { method?: string; body?: unknown }) => Promise<{ ok: boolean; status: number; json: T | null }>;
}

function context(env: Bindings, accountId: string, base: string, services: SetupService[] | null): Ctx {
  const want = (s: Svc) => !services || services.includes(s);
  return {
    env,
    accountId,
    base,
    has: {
      analytics: !!env.ANALYTICS && want("analytics"),
      tags: !!env.TAGS && want("tags"),
      mail: !!env.MAIL && want("mail"),
      replay: !!env.REPLAY && want("replay"),
    },
    call: (svc, path, init) => callService(env, svc, accountId, path, init),
  };
}

/** The website under test: the one asked for, else the project's first (by name). */
function pickDomain(resources: Resources, asked: string | null) {
  const all = [
    ...(resources.sites ?? []).map((s) => normDomain(s.domain)),
    ...(resources.containers ?? []).map((c) => normDomain(c.domain)),
    ...(resources.replaySites ?? []).map((r) => normDomain(r.domain)),
  ];
  const domains = [...new Set(all)].sort();
  const domain = asked ?? domains[0] ?? null;
  const find = <I extends { domain: string }>(items: I[] | null) =>
    domain ? (items?.find((i) => normDomain(i.domain) === domain) ?? null) : null;
  return {
    domain,
    others: domains.filter((d) => d !== domain),
    site: find(resources.sites),
    container: find(resources.containers),
    replaySite: find(resources.replaySites),
  };
}

async function liveConfig(x: Ctx, containerId: string): Promise<LiveConfig | null> {
  const c = await x.call<{ container?: { live_version?: number | null } }>("tags", `/v1/containers/${containerId}`);
  const live = c.json?.container?.live_version;
  if (!live) return null;
  const v = await x.call<{ config?: LiveConfig }>("tags", `/v1/containers/${containerId}/versions/${live}`);
  return v.json?.config ?? null;
}

// ---------- server-side tests ----------

async function mailTest(x: Ctx): Promise<SetupTest> {
  const M = serviceUrl(x.base, "mail");
  const base = { id: "mail.roundtrip", service: "mail" as const, title: "Test email: sent, received and read back" };
  const res = await x.call<{ inboxes?: { id: string; address: string; domain?: string }[]; shared_domain?: string }>("mail", "/v1/inboxes");
  if (!res.ok) return { ...base, status: "failed", detail: `The mail service didn't answer (${res.status}).` };
  const inboxes = res.json?.inboxes ?? [];
  if (!inboxes.length)
    return { ...base, status: "skipped", detail: "The project has no inbox.", fix: `POST ${M}/v1/inboxes {"username":"example-signups"}` };
  // A shared-domain inbox can always send; a custom domain needs its sending records verified.
  const inbox = inboxes.find((i) => i.domain && i.domain === res.json?.shared_domain) ?? inboxes[0]!;
  const [user, dom] = inbox.address.split("@");
  const to = `${user}+${TEST_TAG}@${dom}`;
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 900000));
  const sentAt = Date.now();
  const sent = await x.call<{ internal?: { status: string; reason?: string }[]; daily?: { used: number; limit: number | null } }>(
    "mail",
    `/v1/inboxes/${inbox.id}/send`,
    {
      method: "POST",
      body: {
        to,
        subject: "AgentFirstStack setup test: your verification code",
        text: `Your verification code: ${code}\n\nThis is a test email from the AgentFirstStack setup test. Nothing to do: it checks this inbox can send and receive.`,
      },
    },
  );
  if (!sent.ok)
    return {
      ...base,
      status: "failed",
      detail: `Sending from ${inbox.address} failed (${sent.status}): ${errOf(sent.json)}`,
      fix: `POST ${M}/v1/inboxes/${inbox.id}/send says why; GET ${M}/v1/usage shows the daily send count.`,
    };
  const internal = sent.json?.internal?.[0];
  if (internal && internal.status !== "delivered")
    return { ...base, status: "failed", detail: `Sent, but delivery to ${to} was rejected: ${internal.reason ?? "no reason given"}.` };
  // Wait for the message itself (anything to the +afs-test address), then check its code: one that
  // arrived but whose code wasn't read is a different failure from one that didn't arrive.
  const got = await x.call<{ message?: { id: string; code?: string | null; codes?: string[] } }>(
    "mail",
    `/v1/inboxes/${inbox.id}/wait?tag=${TEST_TAG}&after=${sentAt - 1000}&timeout=20`,
  );
  const ms = Date.now() - sentAt;
  const daily = sent.json?.daily;
  const usage = daily ? ` It used 1 of the day's ${daily.limit ?? "unlimited"} sends (${daily.used} so far).` : "";
  const m = got.json?.message;
  if (!got.ok || !m)
    return {
      ...base,
      status: "failed",
      detail: `Sent from ${inbox.address} to ${to}, but it didn't arrive within 20 s (${got.status}: ${errOf(got.json)}).`,
      fix: `GET ${M}/v1/inboxes/${inbox.id}/messages?tag=${TEST_TAG} shows what arrived.`,
    };
  if (m.code !== code && !(m.codes ?? []).includes(code))
    return {
      ...base,
      status: "failed",
      detail: `Arrived in ${ms} ms (${m.id}), but the code read back was ${m.code ?? "none"}, not ${code}.`,
    };
  return {
    ...base,
    status: "passed",
    detail: `Sent from ${inbox.address} to ${to}, received in ${ms} ms, and its code read back.${usage}`,
  };
}

interface VerifyResult {
  ok?: boolean;
  installed?: boolean;
  receiving_events?: boolean;
  receiving_sessions?: boolean;
  domain_verified?: boolean;
  fixes?: string[];
}

async function verifyTest(x: Ctx, svc: "analytics" | "replay", siteId: string, domain: string): Promise<SetupTest> {
  const base = {
    id: `${svc}.verify`,
    service: svc,
    domain,
    title:
      svc === "analytics" ? "Analytics verify: the live homepage loads the tracker" : "Replay verify: the live homepage loads the recorder",
  };
  const r = await x.call<VerifyResult>(svc, `/v1/sites/${siteId}/verify`, { method: "POST", body: {} });
  if (!r.ok) return { ...base, status: "failed", detail: `verify didn't run (${r.status}): ${errOf(r.json)}` };
  const v = r.json ?? {};
  const facts = [
    v.installed ? "installed" : "not installed",
    svc === "analytics"
      ? v.receiving_events
        ? "receiving events"
        : "no events yet"
      : v.receiving_sessions
        ? "recording sessions"
        : "no sessions yet",
    v.domain_verified ? "domain verified" : "domain not verified",
  ].join(", ");
  return v.ok
    ? { ...base, status: "passed", detail: `${facts}.` }
    : {
        ...base,
        status: "failed",
        detail: `${facts}.`,
        fix: (v.fixes ?? []).slice(0, 3).join(" ") || `POST ${serviceUrl(x.base, svc)}/v1/sites/${siteId}/verify`,
      };
}

/** Recent test events in analytics since a time (realtime, debug only). */
async function analyticsTestEvents(x: Ctx, siteId: string, since: number) {
  const r = await x.call<{ recent_events?: { name: string; pathname?: string; debug?: boolean; ts?: number }[] }>(
    "analytics",
    `/v1/sites/${siteId}/realtime?debug=only&minutes=60&since=${since}&limit=200`,
  );
  return r.ok ? (r.json?.recent_events ?? []) : null;
}

async function analyticsIngestTest(x: Ctx, siteId: string, domain: string, start: number): Promise<SetupTest> {
  const base = { id: "analytics.test_event", service: "analytics" as const, domain, title: "A test event reaches analytics" };
  const sent = await x.call("analytics", `/v1/sites/${siteId}/events`, {
    method: "POST",
    body: { events: [{ name: ANALYTICS_TEST_EVENT, debug: true, visit: false, url: `https://${domain}/` }] },
  });
  if (!sent.ok) return { ...base, status: "failed", detail: `Sending it failed (${sent.status}): ${errOf(sent.json)}` };
  for (const wait of [300, 1000, 2000]) {
    await sleep(wait);
    const events = await analyticsTestEvents(x, siteId, start);
    if (events?.some((e) => e.name === ANALYTICS_TEST_EVENT))
      return {
        ...base,
        status: "passed",
        detail: `${ANALYTICS_TEST_EVENT} was stored as test traffic (kept out of reports, deleted after 7 days).`,
      };
  }
  return { ...base, status: "failed", detail: `${ANALYTICS_TEST_EVENT} was accepted but didn't show in realtime?debug=only within 3 s.` };
}

interface TagsLogEntry {
  name: string;
  type?: string;
  event_id?: string;
  source?: string;
  preview?: boolean;
  test?: boolean;
  status?: string;
  destinations?: { destination_id: string; type: string; status: string; reason?: string; error?: string }[];
}

async function tagsLog(x: Ctx, containerId: string, q: string) {
  const r = await x.call<{ events?: TagsLogEntry[] }>("tags", `/v1/containers/${containerId}/events?${q}`);
  return r.ok ? (r.json?.events ?? []) : null;
}

const settled = (e: TagsLogEntry) => (e.destinations ?? []).every((d) => d.status !== "queued" && d.status !== "retrying");

async function tagsTests(
  x: Ctx,
  containerId: string,
  siteId: string | null,
  domain: string,
  start: number,
  config: LiveConfig | null,
): Promise<SetupTest[]> {
  const T = serviceUrl(x.base, "tags");
  const tests: SetupTest[] = [];
  // 1. The container's path to analytics: an event no conversion uses goes to analytics only.
  const pathTitle = "A test event goes through the tag manager to analytics";
  const id = `afs-test-${start}`;
  const sent = await x.call<{ results?: { destinations?: { type: string; status: string; reason?: string }[] }[] }>(
    "tags",
    `/v1/containers/${containerId}/events`,
    { method: "POST", body: { test: true, events: [{ name: TAGS_TEST_EVENT, event_id: id }] } },
  );
  if (!sent.ok)
    tests.push({
      id: "tags.to_analytics",
      service: "tags",
      domain,
      status: "failed",
      title: pathTitle,
      detail: `Sending it failed (${sent.status}): ${errOf(sent.json)}`,
    });
  else {
    const toAnalytics = (sent.json?.results?.[0]?.destinations ?? []).find((d) => d.type === "analytics");
    const browserTag = (config?.tags ?? []).some((t) => t.type === "analytics" && t.enabled !== false);
    if (!toAnalytics && browserTag)
      tests.push({
        id: "tags.to_analytics",
        service: "tags",
        domain,
        status: "skipped",
        title: pathTitle,
        detail:
          "The container sends events to analytics from the browser (its analytics tag), not from the server: the browser test visit tests that path.",
      });
    else if (!toAnalytics)
      tests.push({
        id: "tags.to_analytics",
        service: "tags",
        domain,
        status: "failed",
        title: pathTitle,
        detail: "The container has no route to analytics.",
        fix: `Run setup with "analytics" in platforms (POST ${T}/v1/containers/${containerId}/setup), then publish.`,
      });
    else {
      let arrived = false;
      for (const wait of [1500, 2000, 3000, 3500]) {
        await sleep(wait);
        const events = siteId ? await analyticsTestEvents(x, siteId, start) : null;
        if (events?.some((e) => e.name === TAGS_TEST_EVENT)) {
          arrived = true;
          break;
        }
      }
      tests.push(
        arrived
          ? {
              id: "tags.to_analytics",
              service: "tags",
              domain,
              status: "passed",
              title: pathTitle,
              detail: `${TAGS_TEST_EVENT} arrived in analytics as test traffic.`,
            }
          : {
              id: "tags.to_analytics",
              service: "tags",
              domain,
              status: "failed",
              title: pathTitle,
              detail: siteId
                ? `${TAGS_TEST_EVENT} didn't arrive in analytics within 10 s.`
                : "There's no analytics site for this domain to receive it.",
              fix: `GET ${T}/v1/containers/${containerId}/events?name=${TAGS_TEST_EVENT}&since=15m shows the analytics delivery's answer.`,
            },
      );
    }
  }

  // 2. Each conversion that goes to an ad platform, in that platform's test mode.
  const dests = await x.call<{ destinations?: { id: string; type: string; name: string | null; enabled: boolean }[] }>(
    "tags",
    `/v1/containers/${containerId}/destinations`,
  );
  const ads = (dests.json?.destinations ?? []).filter((d) => d.enabled && d.type !== "analytics");
  const adTitle = "Test conversions reach each ad platform (in its test mode)";
  if (!ads.length) {
    tests.push({
      id: "tags.ad_platforms",
      service: "tags",
      domain,
      status: "skipped",
      title: adTitle,
      detail: "No ad platforms are connected.",
    });
    return tests;
  }
  const adTypes = new Set(ads.map((d) => d.type));
  const conversions = (config?.conversions ?? []).filter((c) => Object.keys(c.send_to ?? {}).some((k) => adTypes.has(k))).slice(0, 20);
  if (!conversions.length) {
    tests.push({
      id: "tags.ad_platforms",
      service: "tags",
      domain,
      status: "failed",
      title: adTitle,
      detail: `${list(ads.map((d) => d.name ?? d.type))} ${ads.length === 1 ? "is" : "are"} connected, but no live conversion is sent to ${ads.length === 1 ? "it" : "them"}.`,
      fix: `Add send_to for each platform to the conversions (PATCH ${T}/v1/containers/${containerId}/draft), then publish.`,
    });
    return tests;
  }
  const runId = `afs-test-${start}`;
  const r = await x.call("tags", `/v1/containers/${containerId}/events`, {
    method: "POST",
    // No identity fields: a test must not create or link a visitor. Only the ad destinations, so the
    // conversions don't reach analytics and make its goals look verified.
    body: {
      test: true,
      events: conversions.map((c, i) => ({ name: c.name, event_id: `${runId}-${i}`, destinations: ads.map((d) => d.id) })),
    },
  });
  if (!r.ok) {
    tests.push({
      id: "tags.ad_platforms",
      service: "tags",
      domain,
      status: "failed",
      title: adTitle,
      detail: `Sending them failed (${r.status}): ${errOf(r.json)}`,
    });
    return tests;
  }
  let entries: TagsLogEntry[] = [];
  for (const wait of [2000, 2500, 3000, 3500]) {
    await sleep(wait);
    entries = ((await tagsLog(x, containerId, `since=${start}&source=server&limit=200`)) ?? []).filter((e) =>
      e.event_id?.startsWith(`${runId}-`),
    );
    if (entries.length >= conversions.length && entries.every(settled)) break;
  }
  // One result per platform: accepted in test mode, not sent (no test mode), or failing.
  for (const d of ads) {
    const outcomes = entries.flatMap((e) =>
      (e.destinations ?? []).filter((x) => x.destination_id === d.id).map((x) => ({ ...x, event: e.name })),
    );
    const name = d.name ?? d.type;
    const failed = outcomes.filter((o) => o.status === "failed");
    const skipped = outcomes.filter((o) => o.status === "skipped");
    const delivered = outcomes.filter((o) => o.status === "delivered");
    const pending = outcomes.filter((o) => o.status === "queued" || o.status === "retrying");
    const t = { id: `tags.ad_platform.${d.id}`, service: "tags" as const, domain, title: `${name}: test conversions` };
    if (failed.length)
      tests.push({
        ...t,
        status: "failed",
        detail: `${plural(failed.length, "test conversion")} failed (${list(failed.map((f) => f.event))}): ${failed[0]?.error ?? failed[0]?.reason ?? "see the event log"}.`,
        fix: `GET ${T}/v1/containers/${containerId}/destinations/${d.id} shows the last failure; fix the credentials or mapping, then run the test again.`,
      });
    else if (delivered.length)
      tests.push({
        ...t,
        status: "passed",
        detail: `${plural(delivered.length, "test conversion")} accepted in test mode: ${list(delivered.map((o) => o.event))}.`,
      });
    else if (skipped.length)
      tests.push({
        ...t,
        status: "skipped",
        detail: `Not sent: ${skipped[0]?.reason ?? "the platform has no test mode"}. It can only be checked with a real conversion.`,
      });
    else if (pending.length)
      tests.push({
        ...t,
        status: "failed",
        detail: "Still queued after 10 s.",
        fix: `GET ${T}/v1/containers/${containerId}/events?since=15m shows the deliveries.`,
      });
    else tests.push({ ...t, status: "skipped", detail: "No live conversion is sent to it." });
  }
  return tests;
}

// ---------- the browser plan ----------

const PAGE_VARS = new Set(["page_path", "page_url", "page_hostname"]);
const OPS: Record<string, string> = {
  equals: "is",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  matches_regex: "matches",
  not_equals: "isn't",
};

function whereText(t: Trigger) {
  const page = (t.conditions ?? []).filter((c) => PAGE_VARS.has(c.var));
  if (!page.length) return "";
  return ` on a page whose ${page.map((c) => `${c.var.replace("page_", "")} ${OPS[c.op] ?? c.op} ${String(c.value)}`).join(" and ")}`;
}

const opensApp = (t: Trigger) => /mailto:|tel:|sms:/i.test(t.selector ?? "");

function stepFor(t: Trigger, event: string): { step?: BrowserStep; skip?: string } {
  const where = whereText(t);
  const sel = t.selector ? `\`${t.selector}\`` : "";
  const note = t.description ? ` (${t.description})` : "";
  switch (t.type) {
    case "click":
      if (opensApp(t))
        return {
          skip: `${event}: its links open a mail or phone app, so don't click them; open a tags preview and check the trigger in its log.`,
        };
      return { step: { action: `Click an element matching ${sel || "the trigger"}${where}${note}.`, expect: [event] } };
    case "form_submit":
      return {
        step: {
          action: `Submit the form matching ${sel || "the trigger"}${where}${note}, only if that's harmless (a test-mode checkout, a form you can undo); otherwise skip it and check it in a tags preview.`,
          expect: [event],
        },
      };
    case "element_visible":
      return { step: { action: `Scroll until ${sel || "the element"} is visible${where}${note}.`, expect: [event] } };
    case "scroll_depth":
      return { step: { action: `Scroll to the bottom of a page${where}${note}.`, expect: [event] } };
    case "page_view":
      return { step: { action: `Open a page${where || " (any)"}${note}.`, expect: [event] } };
    case "custom_event":
      return { step: { action: `Do what makes the page send the \`${t.event ?? "custom"}\` event${where}${note}.`, expect: [event] } };
    default:
      return { step: { action: `Trigger \`${t.id}\` (a ${t.type} trigger)${where}${note}.`, expect: [event] } };
  }
}

export function browserPlan(base: string, domain: string, since: number, config: LiveConfig | null, goals: Goal[]): BrowserPlan {
  const start_url = `https://${domain}/?afsa_debug=1&afsr=1`;
  const steps: BrowserStep[] = [
    {
      action: `Open ${start_url} in a new window (a fresh one, so it loads the latest tags version). Everything in this tab is now test traffic: kept out of the owner's reports, recorded as a test replay, and never sent to an ad platform as a real conversion. Stay in this tab.`,
    },
  ];
  const expected = new Set<string>();
  const notInBrowser: string[] = [];
  // Pageview goals with a concrete path.
  for (const g of goals.filter((g) => g.type === "pageview" && g.match.startsWith("/") && !g.match.includes("*") && g.match !== "/"))
    steps.push({ action: `Open https://${domain}${g.match} (goal "${g.name}").` });
  const triggers = new Map((config?.triggers ?? []).map((t) => [t.id, t]));
  for (const c of config?.conversions ?? []) {
    const t = c.trigger ? triggers.get(c.trigger) : undefined;
    const event = c.send_to?.analytics?.event_name || c.name;
    if (!t) {
      notInBrowser.push(`${c.name}: no browser trigger (sent by the backend); send it once with "test": true from the backend.`);
      continue;
    }
    const { step, skip } = stepFor(t, event);
    if (skip) notInBrowser.push(skip);
    if (step) {
      steps.push(step);
      expected.add(event);
    }
  }
  const check = `${base}/v1/setup/test?since=${since}&domain=${domain}`;
  steps.push({
    action: `Wait 5 seconds, then GET ${check} (MCP afs_check_test_visit {"since": ${since}}). It checks each expected event arrived. Run it within an hour.`,
  });
  return { domain, start_url, steps, expected_events: [...expected], not_in_browser: notInBrowser, check };
}

// ---------- the browser check ----------

async function browserChecks(
  x: Ctx,
  picked: ReturnType<typeof pickDomain>,
  since: number,
  config: LiveConfig | null,
  goals: Goal[],
): Promise<SetupTest[]> {
  const domain = picked.domain!;
  const tests: SetupTest[] = [];
  const plan = browserPlan(x.base, domain, since, config, goals);
  const [aEvents, tEvents, sessions] = await Promise.all([
    x.has.analytics && picked.site ? analyticsTestEvents(x, picked.site.id, since) : Promise.resolve(null),
    x.has.tags && picked.container ? tagsLog(x, picked.container.id, `since=${since}&source=browser&limit=200`) : Promise.resolve(null),
    x.has.replay && picked.replaySite
      ? x.call<{ sessions?: { id: string; pageviews: number; clicks: number; started_at: number }[] }>(
          "replay",
          `/v1/sites/${picked.replaySite.id}/sessions?from=${since}&forced=true&sort=recent&limit=5`,
        )
      : Promise.resolve(null),
  ]);

  if (x.has.analytics && picked.site) {
    const pages = [...new Set((aEvents ?? []).filter((e) => e.name === "pageview").map((e) => e.pathname ?? "/"))];
    tests.push(
      aEvents === null
        ? {
            id: "browser.pageviews",
            service: "browser",
            domain,
            status: "failed",
            title: "Test pageviews reached analytics",
            detail: "The analytics service didn't answer.",
          }
        : pages.length
          ? {
              id: "browser.pageviews",
              service: "browser",
              domain,
              status: "passed",
              title: "Test pageviews reached analytics",
              detail: `${plural(pages.length, "page")}: ${list(pages)}.`,
            }
          : {
              id: "browser.pageviews",
              service: "browser",
              domain,
              status: "failed",
              title: "Test pageviews reached analytics",
              detail: `No test pageviews since ${new Date(since).toISOString()}.`,
              fix: `Open ${plan.start_url} in a real browser (the first page needs ?afsa_debug=1), then check again. A browser that blocks scripts or sends Global Privacy Control isn't counted.`,
            },
    );
  }

  if (plan.expected_events.length) {
    const inAnalytics = new Set((aEvents ?? []).map((e) => e.name));
    const inTags = new Set((tEvents ?? []).map((e) => e.name));
    const rows = plan.expected_events.map((ev) => {
      const conv = (config?.conversions ?? []).find((c) => (c.send_to?.analytics?.event_name || c.name) === ev);
      const tagsName = conv?.name ?? ev;
      return { ev, analytics: !picked.site || inAnalytics.has(ev), tags: !picked.container || inTags.has(tagsName) };
    });
    const missing = rows.filter((r) => !r.analytics || !r.tags);
    tests.push(
      missing.length
        ? {
            id: "browser.events",
            service: "browser",
            domain,
            status: "failed",
            title: "Each main action reached analytics and the tag manager",
            detail: `${rows.length - missing.length} of ${rows.length} arrived. Missing: ${list(
              missing.map((m) => `${m.ev}${!m.tags ? " (not in the tags event log)" : " (not in analytics)"}`),
            )}.`,
            fix: `Do those steps of the browser plan again. If one still doesn't arrive, open a tags preview (POST ${serviceUrl(x.base, "tags")}/v1/containers/${picked.container?.id}/preview) on that page: its log says why the trigger didn't match.`,
          }
        : {
            id: "browser.events",
            service: "browser",
            domain,
            status: "passed",
            title: "Each main action reached analytics and the tag manager",
            detail: `All ${plural(rows.length, "event")} arrived: ${list(plan.expected_events, 30)}.`,
          },
    );
  }

  // Browser test clicks must never have gone out as live conversions.
  if (tEvents?.length) {
    const conversionNames = new Set((config?.conversions ?? []).map((c) => c.name));
    const live = tEvents.filter((e) => conversionNames.has(e.name) && !e.preview && !e.test);
    const sentLive = live.filter((e) =>
      (e.destinations ?? []).some((d) => d.type !== "analytics" && (d.status === "delivered" || d.status === "queued")),
    );
    tests.push(
      live.length
        ? {
            id: "browser.test_flag",
            service: "browser",
            domain,
            status: "failed",
            title: "The test clicks were treated as test traffic",
            detail: `${plural(live.length, "conversion")} from browsers since then ${live.length === 1 ? "was" : "were"} live, not test${
              sentLive.length ? `, and ${sentLive.length} went to an ad platform` : ""
            }. Either the first page wasn't opened with ?afsa_debug=1, someone else visited, or the tab had an older tags runtime.`,
            fix: `Open ${plan.start_url} in a new window and do the steps again.`,
          }
        : {
            id: "browser.test_flag",
            service: "browser",
            domain,
            status: "passed",
            title: "The test clicks were treated as test traffic",
            detail: "None of them reached an ad platform as a real conversion.",
          },
    );
  }

  if (x.has.replay && picked.replaySite) {
    const s = sessions?.json?.sessions?.[0];
    tests.push(
      !sessions?.ok
        ? {
            id: "browser.replay",
            service: "browser",
            domain,
            status: "failed",
            title: "The visit was recorded as a test replay",
            detail: "The replay service didn't answer.",
          }
        : s
          ? {
              id: "browser.replay",
              service: "browser",
              domain,
              status: "passed",
              title: "The visit was recorded as a test replay",
              detail: `Session ${s.id}: ${plural(s.pageviews, "page")}, ${plural(s.clicks, "click")}.`,
            }
          : {
              id: "browser.replay",
              service: "browser",
              domain,
              status: "failed",
              title: "The visit was recorded as a test replay",
              detail: "No test recording since then.",
              fix: `Open ${plan.start_url} (afsr=1 forces a recording). If the browser is in the EU, UK or Switzerland and the site has require_consent: "eea", it's recorded only after consent.`,
            },
    );
  }
  return tests;
}

// ---------- the run ----------

function finish(
  project: TestRun["project"],
  started: number,
  tests: SetupTest[],
  extra: Partial<TestRun>,
  kind: "server" | "browser",
): TestRun {
  const failed = tests.filter((t) => t.status === "failed");
  const passedCount = tests.filter((t) => t.status === "passed").length;
  const skipped = tests.length - failed.length - passedCount;
  const passed = failed.length === 0 && passedCount > 0;
  const what = kind === "server" ? "Server tests" : "Browser visit";
  const summary = passed
    ? `${what}: ${passedCount} passed${skipped ? `, ${skipped} skipped` : ""}.`
    : `${what}: ${plural(failed.length, "test")} failed, ${passedCount} passed${skipped ? `, ${skipped} skipped` : ""}.`;
  const next_steps = [
    ...failed.map((t) => `${t.title}${t.domain ? ` (${t.domain})` : ""}: ${t.fix ?? t.detail}`),
    ...(extra.next_steps ?? []),
  ];
  const run: TestRun = {
    project,
    started_at: started,
    finished_at: Date.now(),
    passed,
    summary,
    tests,
    ...extra,
    next_steps,
    report_markdown: "",
  };
  run.report_markdown = testMarkdown(run, kind);
  return run;
}

const MARK: Record<TestStatus, string> = { passed: "✅", failed: "❌", skipped: "➖" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function testMarkdown(run: TestRun, kind: "server" | "browser"): string {
  const name = run.project.name ?? run.project.id;
  const head = `**AgentFirstStack ${kind === "server" ? "setup test" : "browser test visit"} for ${name}: ${run.passed ? "passed" : "failed"}** (${run.summary.replace(/^[^:]+: /, "")})`;
  const lines = [head, "", "| | Test | Result |", "|---|---|---|"];
  for (const t of run.tests) lines.push(`| ${MARK[t.status]} | ${cell(t.title)} | ${cell(t.detail)} |`);
  lines.push("", "✅ passed · ❌ failed · ➖ skipped (not set up, or the platform has no test mode)");
  return lines.join("\n");
}

async function projectName(env: Bindings, accountId: string) {
  const row = await env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(accountId).first<{ name: string | null }>();
  return row?.name?.trim() || null;
}

export async function runSetupTest(
  env: Bindings,
  accountId: string,
  opts: { base: string; domain?: string | null; services?: SetupService[] | null },
): Promise<TestRun> {
  if (env.SETUP_TEST_LIMITER) {
    const { success } = await env.SETUP_TEST_LIMITER.limit({ key: `setup-test|${accountId}` });
    if (!success)
      throw tooManyRequests(
        "The setup test sends real test traffic: at most 3 runs a minute per project. Wait a minute, then run it again.",
      );
  }
  const x = context(env, accountId, opts.base, opts.services ?? null);
  const start = Date.now();
  const [resources, name] = await Promise.all([projectResources(env, accountId), projectName(env, accountId)]);
  const picked = pickDomain(resources, opts.domain ?? null);
  const domain = picked.domain;
  const [config, goals] = await Promise.all([
    x.has.tags && picked.container ? liveConfig(x, picked.container.id) : Promise.resolve(null),
    x.has.analytics && picked.site
      ? x.call<{ goals?: Goal[] }>("analytics", `/v1/sites/${picked.site.id}/goals`).then((r) => r.json?.goals ?? [])
      : Promise.resolve([] as Goal[]),
  ]);
  const jobs: Promise<SetupTest | SetupTest[]>[] = [];
  if (x.has.mail) jobs.push(mailTest(x));
  if (domain && x.has.analytics && picked.site) {
    jobs.push(verifyTest(x, "analytics", picked.site.id, domain));
    jobs.push(analyticsIngestTest(x, picked.site.id, domain, start));
  }
  if (domain && x.has.tags && picked.container)
    jobs.push(tagsTests(x, picked.container.id, picked.site?.id ?? null, domain, start, config));
  if (domain && x.has.replay && picked.replaySite) jobs.push(verifyTest(x, "replay", picked.replaySite.id, domain));
  const tests = (await Promise.all(jobs)).flat();
  const missing: SetupTest[] = [];
  if (domain) {
    if (x.has.analytics && !picked.site)
      missing.push({
        id: "analytics.verify",
        service: "analytics",
        domain,
        status: "skipped",
        title: "Analytics",
        detail: "No analytics site for this domain.",
      });
    if (x.has.tags && !picked.container)
      missing.push({
        id: "tags.to_analytics",
        service: "tags",
        domain,
        status: "skipped",
        title: "Tag manager",
        detail: "No tag container for this domain.",
      });
    if (x.has.replay && !picked.replaySite)
      missing.push({
        id: "replay.verify",
        service: "replay",
        domain,
        status: "skipped",
        title: "Replay",
        detail: "No replay site for this domain.",
      });
  }
  const plan = domain && (picked.site || picked.container) ? browserPlan(opts.base, domain, start, config, goals) : undefined;
  return finish(
    { id: accountId, name },
    start,
    [...tests, ...missing],
    {
      ...(plan ? { browser_plan: plan } : {}),
      next_steps: [
        ...(plan ? [`Then test in a real browser: follow browser_plan.steps, and check the visit with GET ${plan.check}.`] : []),
        ...(picked.others.length
          ? [`Other websites in this project: POST ${opts.base}/v1/setup/test {"domain":"${picked.others[0]}"}`]
          : []),
      ],
    },
    "server",
  );
}

export async function checkTestVisit(
  env: Bindings,
  accountId: string,
  opts: { base: string; since: number; domain?: string | null },
): Promise<TestRun> {
  const x = context(env, accountId, opts.base, null);
  const [resources, name] = await Promise.all([projectResources(env, accountId), projectName(env, accountId)]);
  const picked = pickDomain(resources, opts.domain ?? null);
  if (!picked.domain)
    throw badRequest(
      "The project has no website yet.",
      `Create the analytics site first: POST ${serviceUrl(opts.base, "analytics")}/v1/sites {"domain":"example.com"}`,
    );
  const [config, goals] = await Promise.all([
    x.has.tags && picked.container ? liveConfig(x, picked.container.id) : Promise.resolve(null),
    x.has.analytics && picked.site
      ? x.call<{ goals?: Goal[] }>("analytics", `/v1/sites/${picked.site.id}/goals`).then((r) => r.json?.goals ?? [])
      : Promise.resolve([] as Goal[]),
  ]);
  const tests = await browserChecks(x, picked, opts.since, config, goals);
  return finish({ id: accountId, name }, opts.since, tests, {}, "browser");
}

// ---------- REST ----------

function readSince(raw: string | undefined): number {
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(n))
    throw badRequest(
      "`since` is required: the started_at the setup test returned (unix ms or ISO).",
      "GET /v1/setup/test?since=1793000000000",
    );
  if (Date.now() - n > BROWSER_WINDOW_MS)
    throw badRequest(
      "`since` is more than an hour ago: the browser check reads the last hour.",
      "Run POST /v1/setup/test again and do the browser plan within the hour.",
    );
  return n;
}

export const setupTestApi = new Hono<SiteEnv>();

setupTestApi.post("/v1/setup/test", requireAuth<SiteEnv>(), async (c) => {
  const auth: AuthContext = c.var.auth;
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { domain?: unknown; services?: unknown };
  const rawDomain = typeof body.domain === "string" ? body.domain : "";
  const domain = rawDomain ? parseDomain(rawDomain) : null;
  if (rawDomain && !domain) throw badRequest("`domain` isn't a host name.", 'Example: {"domain":"example.com"}');
  const services = body.services === undefined ? null : parseServices(body.services);
  if (body.services !== undefined && !services)
    throw badRequest(
      "`services` names a service that doesn't exist.",
      'Any of analytics, tags, mail, replay, e.g. {"services":["analytics","tags"]}.',
    );
  return c.json(await runSetupTest(c.env, auth.accountId, { base: siteBase(c), domain, services }));
});

setupTestApi.get("/v1/setup/test", requireAuth<SiteEnv>(), async (c) => {
  const auth: AuthContext = c.var.auth;
  const since = readSince(c.req.query("since"));
  const raw = c.req.query("domain");
  const domain = raw ? parseDomain(raw) : null;
  if (raw && !domain) throw badRequest("`domain` isn't a host name.", "Example: GET /v1/setup/test?since=...&domain=example.com");
  if (c.env.SETUP_LIMITER) {
    const { success } = await c.env.SETUP_LIMITER.limit({ key: `setup|${auth.accountId}` });
    if (!success) throw tooManyRequests("Checking too often (30 a minute per project). Wait a minute, then check again.");
  }
  return c.json(await checkTestVisit(c.env, auth.accountId, { base: siteBase(c), since, domain }));
});

export { readSince };
