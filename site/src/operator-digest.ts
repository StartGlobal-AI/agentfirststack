import type { Bindings } from "./env";
import { queueEmail } from "./email";

/**
 * The operator's daily summary (OPERATOR_EMAIL, comma-separated; off when unset): what happened on
 * the deployment in the last 24 hours, so trouble shows up before a customer writes in. Everything
 * comes from the identity DB, plus one cheap request per service to see that it answers. Worker
 * errors aren't here (they live in Cloudflare's Workers observability).
 */

const DAY = 86_400_000;
const SERVICES = [
  ["analytics", "ANALYTICS"],
  ["tags", "TAGS"],
  ["mail", "MAIL"],
  ["replay", "REPLAY"],
] as const;

export interface Digest {
  since: number;
  until: number;
  projects: { created: number; claimed: number; live: number; claimed_total: number; deleted: number; purged: number; suspended: number };
  people: { joined: number; total: number };
  signups: { attempts: number; networks: number };
  warnings: { project: string; item: string; level: string }[];
  attacks: { project: string; item: string; level: string }[];
  emails: { sent: number; failed: number; skipped: number; pending: number; failures: { kind: string; error: string; n: number }[] };
  services: { service: string; ok: boolean; detail: string }[];
}

const n = (v: unknown) => Number(v ?? 0) || 0;

export async function buildDigest(env: Bindings, now = Date.now()): Promise<Digest> {
  const db = env.DB;
  const since = now - DAY;
  const one = async (sql: string, ...args: unknown[]) =>
    (await db
      .prepare(sql)
      .bind(...args)
      .first<Record<string, unknown>>()) ?? {};
  const [p, claimed, people, signups, warnRows, mail, failures] = await Promise.all([
    one(
      `SELECT SUM(created_at > ?1) AS created,
              SUM(deleted_at IS NULL AND purged_at IS NULL) AS live,
              SUM(deleted_at > ?1) AS deleted, SUM(purged_at > ?1) AS purged, SUM(suspended_at > ?1) AS suspended
       FROM accounts`,
      since,
    ),
    one(
      `SELECT COUNT(DISTINCT CASE WHEN m.created_at > ?1 THEN m.account_id END) AS claimed, COUNT(DISTINCT m.account_id) AS total
       FROM memberships m JOIN accounts a ON a.id = m.account_id
       WHERE m.role = 'owner' AND a.deleted_at IS NULL AND a.purged_at IS NULL`,
      since,
    ),
    one("SELECT SUM(created_at > ?1) AS joined, COUNT(*) AS total FROM users", since),
    one("SELECT COUNT(*) AS attempts, COUNT(DISTINCT ip_hash) AS networks FROM signup_log WHERE created_at > ?1", since),
    db
      .prepare(
        `SELECT COALESCE(a.name, w.account_id) AS project, w.item, w.level FROM limit_warnings w
         LEFT JOIN accounts a ON a.id = w.account_id WHERE w.warned_at > ? ORDER BY w.warned_at DESC LIMIT 40`,
      )
      .bind(since)
      .all<{ project: string; item: string; level: string }>(),
    one(
      `SELECT SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed, SUM(status = 'skipped') AS skipped,
              SUM(status = 'pending') AS pending FROM email_outbox WHERE created_at > ?1`,
      since,
    ),
    db
      .prepare(
        `SELECT kind, COALESCE(error, '') AS error, COUNT(*) AS n FROM email_outbox
         WHERE created_at > ? AND status = 'failed' GROUP BY kind, error ORDER BY n DESC LIMIT 5`,
      )
      .bind(since)
      .all<{ kind: string; error: string; n: number }>(),
  ]);
  const rows = warnRows.results ?? [];
  const services = await Promise.all(
    SERVICES.map(async ([service, binding]) => {
      const svc = env[binding] as Fetcher | undefined;
      if (!svc) return { service, ok: false, detail: "not bound" };
      const started = Date.now();
      try {
        const r = await svc.fetch(`https://${service}.internal/llms.txt`);
        await r.body?.cancel();
        return { service, ok: r.ok, detail: r.ok ? `answered in ${Date.now() - started} ms` : `HTTP ${r.status}` };
      } catch (e) {
        return { service, ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return {
    since,
    until: now,
    projects: {
      created: n(p.created),
      claimed: n(claimed.claimed),
      live: n(p.live),
      claimed_total: n(claimed.total),
      deleted: n(p.deleted),
      purged: n(p.purged),
      suspended: n(p.suspended),
    },
    people: { joined: n(people.joined), total: n(people.total) },
    signups: { attempts: n(signups.attempts), networks: n(signups.networks) },
    warnings: rows.filter((r) => !r.item.includes(".attack:")),
    attacks: rows.filter((r) => r.item.includes(".attack:")),
    emails: {
      sent: n(mail.sent),
      failed: n(mail.failed),
      skipped: n(mail.skipped),
      pending: n(mail.pending),
      failures: (failures.results ?? []).map((f) => ({ kind: f.kind, error: f.error.slice(0, 160), n: n(f.n) })),
    },
    services,
  };
}

const plural = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;

/** "analytics.events_per_site_per_day:site_x" -> "analytics events_per_site_per_day (site_x)" */
const itemText = (item: string) => {
  const [what = item, id] = item.split(":");
  return `${what.replace(".", " ")}${id ? ` (${id})` : ""}`;
};

/** Needs a look: a service down, an attack, failed emails, suspensions. */
export function needsAttention(d: Digest): boolean {
  return d.services.some((s) => !s.ok) || d.attacks.length > 0 || d.emails.failed > 0 || d.projects.suspended > 0;
}

export function digestText(d: Digest, base: string): { subject: string; body: string[] } {
  const down = d.services.filter((s) => !s.ok);
  const day = new Date(d.until).toISOString().slice(0, 10);
  const headline = [
    down.length ? `${down.map((s) => s.service).join(", ")} not answering` : null,
    d.attacks.length ? plural(d.attacks.length, "attack episode") : null,
    d.emails.failed ? plural(d.emails.failed, "failed email") : null,
    `${plural(d.projects.created, "new project")}, ${d.projects.claimed} claimed`,
  ].filter(Boolean);
  const body = [
    `The last 24 hours on ${new URL(base).host}, up to ${new Date(d.until).toISOString().replace("T", " ").slice(0, 16)} UTC.`,
    `Projects: ${plural(d.projects.created, "new project")} (${d.projects.live.toLocaleString("en-US")} live), ${d.projects.claimed} claimed (${d.projects.claimed_total} claimed in all), ${d.projects.deleted} deleted, ${d.projects.purged} erased, ${d.projects.suspended} suspended. People: ${d.people.joined} signed in for the first time (${d.people.total} in all). Signups: ${plural(d.signups.attempts, "attempt")} from ${plural(d.signups.networks, "network")}.`,
    `Services: ${d.services.map((s) => `${s.service} ${s.ok ? "ok" : `DOWN (${s.detail})`}`).join(", ")}.`,
    d.attacks.length
      ? `Suspicious traffic (projects emailed): ${d.attacks
          .slice(0, 10)
          .map((a) => `${a.project}: ${itemText(a.item.split(":").slice(0, 2).join(":"))}, ${a.level.replace("_", " ")}`)
          .join("; ")}.`
      : "Suspicious traffic: none reported.",
    d.warnings.length
      ? `Limit warnings sent: ${d.warnings
          .slice(0, 10)
          .map((w) => `${w.project}: ${itemText(w.item)} ${w.level}`)
          .join("; ")}${d.warnings.length > 10 ? `; and ${d.warnings.length - 10} more` : ""}. People can reply to ask for more.`
      : "Limit warnings sent: none.",
    `Emails: ${d.emails.sent} sent, ${d.emails.failed} failed, ${d.emails.skipped} skipped, ${d.emails.pending} waiting.${
      d.emails.failures.length
        ? ` Failures: ${d.emails.failures.map((f) => `${f.kind} x${f.n}${f.error ? ` (${f.error})` : ""}`).join("; ")}.`
        : ""
    }`,
    "Worker errors aren't in this summary: Cloudflare dashboard, Workers & Pages, each afs- Worker, Observability.",
  ];
  return { subject: `${needsAttention(d) ? "Needs a look: " : ""}AgentFirstStack ${day}: ${headline.join(", ")}`, body };
}

export const operatorAddresses = (env: Bindings) =>
  (env.OPERATOR_EMAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));

/**
 * Daily cron: send the summary to each operator address (once a UTC day; a failed send is retried by
 * the hourly delivery like any email). `manual`
 * (the admin route) sends a fresh one now, whatever was sent today.
 */
export async function emailOperatorDigest(env: Bindings, base: string, now = Date.now(), opts: { manual?: boolean } = {}) {
  const to = operatorAddresses(env);
  if (!to.length) return { sent: 0, skipped: "no OPERATOR_EMAIL" };
  const d = await buildDigest(env, now);
  const { subject, body } = digestText(d, base);
  const day = new Date(now).toISOString().slice(0, 10);
  let sent = 0;
  const results: string[] = [];
  for (const email of to) {
    const dedupeKey = `operator_digest:${opts.manual ? `manual:${now}` : day}:${email.toLowerCase()}`;
    const r = await queueEmail(
      env,
      base,
      {
        kind: "operator_digest",
        category: "account",
        dedupeKey,
        to: { userId: null, email },
        accountId: null,
        content: { subject, body, action: { label: "Open the dashboard", url: `${base}/dashboard` } },
      },
      { now },
    );
    results.push(r);
    if (r === "sent") sent++;
  }
  return { sent, results, attention: needsAttention(d) };
}
