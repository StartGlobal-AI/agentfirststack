import { refreshFxRates } from "./fx";
import { purgeShareAttempts } from "./share";
import { accountStanding } from "@afs/shared";
import type { Bindings } from "../env";
import type { Fetcher } from "../lib/delivery";
import { type AlertRow, checkAlert } from "./alerts";
import type { SiteRow } from "./context";
import { purgeHistory, retryDue } from "./notify";
import { runReports } from "./reports";
import { runStripeBackfills } from "./stripe-connect";

/**
 * The scheduled handler (wrangler.jsonc triggers: every 5 minutes). Bounded per run: at most
 * ALERTS_PER_RUN due alerts, REPORTS_PER_RUN due reports and RETRIES_PER_RUN retries, and it stops
 * starting new work after CRON_BUDGET_MS of wall time; whatever is left is still due next run.
 */

export const ALERTS_PER_RUN = 100;
export const REPORTS_PER_RUN = 50;
export const RETRIES_PER_RUN = 50;
export const CRON_BUDGET_MS = 40_000;

type Due = AlertRow & { s_account_id: string; s_domain: string };

export interface CronOptions {
  fetcher?: Fetcher;
  /** the ECB rates fetch (tests inject one; default fetch) */
  fxFetcher?: Fetcher;
  /** extra work registered by later steps (reports); kept pluggable for tests */
  steps?: ((env: Bindings, now: number, stopAt: number, fetcher?: Fetcher) => Promise<Record<string, number>>)[];
}

async function siteById(env: Bindings, id: string): Promise<SiteRow | null> {
  return env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(id).first<SiteRow>();
}

export async function runAlerts(env: Bindings, now: number, stopAt: number, fetcher?: Fetcher) {
  const { results } = await env.DB.prepare(
    `SELECT a.*, s.account_id AS s_account_id, s.domain AS s_domain FROM alerts a JOIN sites s ON s.id = a.site_id
     WHERE a.enabled = 1 AND a.next_check_at <= ? ORDER BY a.next_check_at LIMIT ?`,
  )
    .bind(now, ALERTS_PER_RUN)
    .all<Due>();
  let checked = 0;
  let fired = 0;
  const sites = new Map<string, SiteRow | null>();
  for (const a of results) {
    if (Date.now() > stopAt) break;
    if ((await accountStanding(env, a.s_account_id)).suspended) {
      await env.DB.prepare("UPDATE alerts SET next_check_at = ? WHERE id = ?")
        .bind(now + 3_600_000, a.id)
        .run();
      continue;
    }
    if (!sites.has(a.site_id)) sites.set(a.site_id, await siteById(env, a.site_id));
    const site = sites.get(a.site_id);
    if (!site) continue;
    const r = await checkAlert(env, site, a, now, fetcher);
    checked++;
    if (r.fired) fired++;
  }
  return { alerts_checked: checked, alerts_fired: fired, alerts_due: results.length };
}

export async function runCron(env: Bindings, now = Date.now(), opts: CronOptions = {}) {
  const stopAt = Date.now() + CRON_BUDGET_MS;
  const out: Record<string, number> = {};
  const fx = (e: Bindings, n: number) => refreshFxRates(e, n, opts.fxFetcher);
  const steps = [runAlerts, runReports, runStripeBackfills, fx, ...(opts.steps ?? [])];
  for (const step of steps) {
    try {
      Object.assign(out, await step(env, now, stopAt, opts.fetcher));
    } catch (e) {
      console.error("cron step failed", e);
    }
  }
  try {
    out.retried = await retryDue(env, now, RETRIES_PER_RUN, opts.fetcher, stopAt);
    out.history_purged = await purgeHistory(env, now);
    out.share_attempts_purged = await purgeShareAttempts(env, now);
  } catch (e) {
    console.error("cron retries / purge failed", e);
  }
  if (Object.values(out).some((v) => v > 0)) console.log(JSON.stringify({ msg: "cron", ...out }));
  return out;
}
