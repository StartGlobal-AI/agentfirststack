import { ApiError, clientNetwork, newId, parse, readJson, sha256Hex } from "@afs/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { waitUntilOf } from "./email";
import { emailAbuseReport, supportAddress } from "./email-messages";
import { type Bindings, DAY, type SiteEnv } from "./env";
import { siteBase } from "./google";
import { html, MARK, messagePage, page } from "./html";

/**
 * Abuse reports from anyone (no account, no captcha): phishing on a share link, spam from an inbox,
 * malware in a tag container, impersonation.
 *
 *   POST /v1/abuse-reports   JSON { url_or_resource, kind, details, contact? }   (MCP afs_report_abuse)
 *   GET  /report-abuse       a small form for people (?url= and ?kind= prefill it; share pages link here)
 *   POST /report-abuse       the form's post
 *
 * Limits (defaults on, vars to change them): ABUSE_REPORTS_HOURLY_LIMIT per network (5) and
 * ABUSE_REPORTS_DAILY_LIMIT for the deployment (500). The same report from the same network within a
 * day is the same report (200, existing: true). Phishing and malware are emailed to OPERATOR_EMAIL at
 * once (at most ABUSE_REPORT_EMAILS_PER_DAY, 20); everything is in the operator's daily summary and
 * GET /v1/admin/abuse-reports.
 */

export const ABUSE_KINDS = ["phishing", "spam", "malware", "impersonation", "other"] as const;
export type AbuseKind = (typeof ABUSE_KINDS)[number];
const URGENT: AbuseKind[] = ["phishing", "malware"];
const HOUR = 3_600_000;

const KIND_LABEL: Record<AbuseKind, string> = {
  phishing: "Phishing (a page or email that tricks people into giving passwords, payment or personal details)",
  spam: "Spam (unsolicited email from one of our inboxes)",
  malware: "Malware (code that harms visitors: miners, skimmers, malicious redirects)",
  impersonation: "Impersonation (pretending to be a person, company or brand)",
  other: "Something else",
};

export const reportBody = z.object({
  url_or_resource: z.string().trim().min(3).max(2000),
  kind: z.enum(ABUSE_KINDS),
  details: z.string().trim().min(1).max(5000),
  contact: z.string().trim().max(320).optional(),
});
export type ReportInput = z.infer<typeof reportBody>;

const oneLine = (s: string, max: number) =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
/** Paragraphs survive, other control characters don't. */
const multiLine = (s: string, max: number) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);

const limit = (raw: string | undefined, fallback: number) => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export const whatHappensNext = (base: string, kind: AbuseKind) => [
  URGENT.includes(kind)
    ? "Phishing and malware reports reach the operator at once; the rest within a day."
    : "The operator reads every report within a day.",
  "If the report holds up, the capability being abused is paused (sending, custom code, share links) or the project is suspended, and its people are told why.",
  "We may not reply to every report. If you gave a contact, we write only if we need more from you.",
  `What the platform may not be used for: ${base}/acceptable-use. Appeals and questions: ${supportAddress(base)}.`,
];

export interface ReportResult {
  report: { id: string; kind: AbuseKind; status: string; created_at: number };
  existing: boolean;
}

/** Store a report (deduped per network for a day) and email the operator if it's urgent. */
export async function fileAbuseReport(
  env: Bindings,
  base: string,
  input: ReportInput,
  reporter: string,
  wu?: (p: Promise<unknown>) => void,
  now = Date.now(),
): Promise<ReportResult> {
  const db = env.DB;
  const network = (await sha256Hex(`abuse|${reporter}`)).slice(0, 32);
  const target = oneLine(input.url_or_resource, 2000);
  const details = multiLine(input.details, 5000);
  const contact = input.contact ? oneLine(input.contact, 320) || null : null;
  const same = await db
    .prepare(
      "SELECT id, kind, status, created_at FROM abuse_reports WHERE network = ? AND target = ? AND kind = ? AND created_at > ? LIMIT 1",
    )
    .bind(network, target, input.kind, now - DAY)
    .first<ReportResult["report"]>();
  if (same) return { report: same, existing: true };

  const counts = await db
    .prepare(
      "SELECT SUM(network = ?1 AND created_at > ?2) AS network_hour, SUM(network = ?1) AS network_day, COUNT(*) AS day FROM abuse_reports WHERE created_at > ?3",
    )
    .bind(network, now - HOUR, now - DAY)
    .first<{ network_hour: number | null; network_day: number | null; day: number }>();
  const hourly = limit(env.ABUSE_REPORTS_HOURLY_LIMIT, 5);
  if (hourly && Number(counts?.network_hour ?? 0) >= hourly)
    throw new ApiError(
      429,
      "rate_limited",
      `At most ${hourly} abuse reports an hour from one network.`,
      `Put everything into one report (details can list several URLs), or write to ${supportAddress(base)}.`,
    );
  const daily = limit(env.ABUSE_REPORTS_DAILY_LIMIT, 500);
  if (daily && Number(counts?.day ?? 0) >= daily)
    throw new ApiError(
      429,
      "rate_limited",
      "This deployment has received unusually many abuse reports today.",
      `Write to ${supportAddress(base)} instead; the form works again tomorrow.`,
    );

  const id = newId("abr");
  await db
    .prepare(
      "INSERT INTO abuse_reports (id, kind, target, details, contact, network, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)",
    )
    .bind(id, input.kind, target, details, contact, network, now)
    .run();
  console.log(JSON.stringify({ event: "abuse.report", id, kind: input.kind }));

  if (URGENT.includes(input.kind)) {
    const emailed = await db
      .prepare("SELECT count(*) AS n FROM abuse_reports WHERE emailed_at > ?")
      .bind(now - DAY)
      .first<number>("n");
    if (Number(emailed ?? 0) < limit(env.ABUSE_REPORT_EMAILS_PER_DAY, 20)) {
      const work = emailAbuseReport(env, base, wu, {
        id,
        kind: input.kind,
        target,
        details,
        contact,
        created_at: now,
        fromNetwork: Number(counts?.network_day ?? 0) + 1,
      })
        .then((queued) => (queued ? db.prepare("UPDATE abuse_reports SET emailed_at = ? WHERE id = ?").bind(now, id).run() : null))
        .catch((e) => console.error("abuse report email failed", e));
      if (wu) wu(work);
      else await work;
    }
  }
  return { report: { id, kind: input.kind, status: "new", created_at: now }, existing: false };
}

export interface AbuseReportRow {
  id: string;
  kind: AbuseKind;
  target: string;
  details: string;
  contact: string | null;
  status: string;
  note: string | null;
  created_at: number;
  emailed_at: number | null;
  reviewed_at: number | null;
}

export async function listAbuseReports(db: D1Database, o: { status?: string; limit?: number } = {}) {
  const n = Math.max(1, Math.min(200, o.limit ?? 50));
  const { results } = o.status
    ? await db
        .prepare("SELECT * FROM abuse_reports WHERE status = ? ORDER BY created_at DESC LIMIT ?")
        .bind(o.status, n)
        .all<AbuseReportRow>()
    : await db.prepare("SELECT * FROM abuse_reports ORDER BY created_at DESC LIMIT ?").bind(n).all<AbuseReportRow>();
  return results.map(({ network: _, ...r }: AbuseReportRow & { network?: string }) => r);
}

export async function reviewAbuseReport(db: D1Database, id: string, status: "new" | "reviewed" | "dismissed", note?: string) {
  const r = await db
    .prepare("UPDATE abuse_reports SET status = ?, note = COALESCE(?, note), reviewed_at = ? WHERE id = ?")
    .bind(status, note ? oneLine(note, 1000) : null, status === "new" ? null : Date.now(), id)
    .run();
  if (!r.meta.changes) throw new ApiError(404, "not_found", "Abuse report not found.", "GET /v1/admin/abuse-reports lists them.");
  return db.prepare("SELECT id, kind, target, status, note, created_at, reviewed_at FROM abuse_reports WHERE id = ?").bind(id).first();
}

/** Daily cron: reports are kept 180 days. */
export async function pruneAbuseReports(db: D1Database, now = Date.now()) {
  const r = await db
    .prepare("DELETE FROM abuse_reports WHERE created_at < ?")
    .bind(now - 180 * DAY)
    .run();
  return r.meta.changes ?? 0;
}

// ---------- routes ----------

export const abuseReportsApi = new Hono<SiteEnv>();

export const abuseAnswer = (base: string, r: ReportResult) => ({
  report: r.report,
  existing: r.existing,
  what_happens_next: whatHappensNext(base, r.report.kind),
  next_steps: [
    `Keep the id (${r.report.id}) if you write to ${supportAddress(base)} about it.`,
    "More URLs from the same abuse: put them in one more report's details.",
  ],
});

abuseReportsApi.post("/v1/abuse-reports", async (c) => {
  const input = await readJson(c, reportBody);
  const base = siteBase(c);
  const r = await fileAbuseReport(c.env, base, input, clientNetwork(c.req.raw), waitUntilOf(c));
  return c.json(abuseAnswer(base, r), r.existing ? 200 : 201);
});

// The form. It posts to itself (form-action 'self'); no script needed.
function formPage(
  c: Context<SiteEnv>,
  o: { url?: string; kind?: string; details?: string; contact?: string; error?: string; status?: number },
) {
  const kind = (ABUSE_KINDS as readonly string[]).includes(o.kind ?? "") ? o.kind : "";
  return page({
    title: "Report abuse",
    status: o.status,
    body: html`<section class="solo">
  <form class="tile solo-card stack abuse-form" method="post" action="/report-abuse">
    <span class="solo-mark">${MARK}</span>
    <h1>Report abuse</h1>
    <p class="lead">Seen phishing, spam, malware or impersonation that uses AgentFirstStack (a share link, an inbox, a tag container, a page)? Tell us. No account needed.</p>
    ${o.error ? html`<p class="notice notice-error" role="alert">${o.error}</p>` : ""}
    <label class="field"><span>The URL, email address or id</span><input type="text" name="url_or_resource" required minlength="3" maxlength="2000" value="${o.url ?? ""}" placeholder="https://replay.agentfirststack.com/play/... or name@agentfirststack.com"></label>
    <label class="field"><span>What kind of abuse</span>
      <select name="kind" required>
        <option value=""${kind ? "" : html` selected`} disabled>Choose one</option>
        ${ABUSE_KINDS.map((k) => html`<option value="${k}"${kind === k ? html` selected` : ""}>${KIND_LABEL[k]}</option>`)}
      </select>
    </label>
    <label class="field"><span>What happened</span><textarea name="details" required maxlength="5000" rows="6" placeholder="What you saw, when, and anything that helps us find it (other URLs, the email's headers).">${o.details ?? ""}</textarea></label>
    <label class="field"><span>Your email (optional, only if we may need more from you)</span><input type="email" name="contact" maxlength="320" value="${o.contact ?? ""}"></label>
    <p class="row"><button class="btn btn-primary" type="submit">Send the report</button></p>
    <p class="muted">Agents: <code>POST /v1/abuse-reports</code> with <code>{"url_or_resource","kind","details","contact"}</code>. What may not be done with the platform: <a href="/acceptable-use">Acceptable Use Policy</a>.</p>
  </form>
</section>`,
  });
}

abuseReportsApi.get("/report-abuse", (c) =>
  formPage(c, { url: (c.req.query("url") ?? "").slice(0, 2000), kind: c.req.query("kind") ?? "" }),
);

abuseReportsApi.post("/report-abuse", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  const raw = { url: str("url_or_resource"), kind: str("kind"), details: str("details"), contact: str("contact") };
  let input: ReportInput;
  try {
    input = parse(reportBody, {
      url_or_resource: raw.url,
      kind: raw.kind,
      details: raw.details,
      ...(raw.contact.trim() ? { contact: raw.contact } : {}),
    });
  } catch {
    return formPage(c, { ...raw, status: 400, error: "Fill in the URL (or address or id), the kind of abuse and what happened." });
  }
  const base = siteBase(c);
  try {
    const r = await fileAbuseReport(c.env, base, input, clientNetwork(c.req.raw), waitUntilOf(c));
    return messagePage({
      title: "Thank you",
      message: `We got your report (${r.report.id}). ${whatHappensNext(base, r.report.kind).slice(0, 2).join(" ")}`,
      action: { href: "/", label: "Home" },
    });
  } catch (e) {
    if (e instanceof ApiError) return formPage(c, { ...raw, status: e.status, error: [e.message, e.hint].filter(Boolean).join(" ") });
    throw e;
  }
});
