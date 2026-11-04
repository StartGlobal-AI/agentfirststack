import { median } from "./stats-math";

/**
 * Alert rules and the decision whether one fires. Pure: the cron asks the site's Durable Object
 * for the numbers (do/alerts.ts), then decides here and delivers.
 *
 *   traffic_spike  visitors in the last `window` >= threshold x the usual (default 2x), where the
 *                  usual is the median of the same clock window on each of the 7 days before, and
 *                  at least min_visitors (default 20) visitors
 *   traffic_drop   visitors <= the usual x (1 - threshold %) (default 50 %), when the usual is at
 *                  least min_visitors
 *   no_data        no events at all for `window` (default 12 h) on a site that had some; fires once,
 *                  then again only after data came back
 *   goal           conversions of `goal` in the last `window` >= threshold (default 1)
 *   payment        new payments (amount >= threshold, default 0) since the last check, batched
 */

export const ALERT_TYPES = ["traffic_spike", "traffic_drop", "no_data", "goal", "payment"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_DEFAULTS: Record<AlertType, { window: number; threshold: number; cooldown: number }> = {
  traffic_spike: { window: 60, threshold: 2, cooldown: 720 },
  traffic_drop: { window: 360, threshold: 50, cooldown: 720 },
  no_data: { window: 720, threshold: 0, cooldown: 0 },
  goal: { window: 60, threshold: 1, cooldown: 60 },
  payment: { window: 5, threshold: 0, cooldown: 0 },
};
export const DEFAULT_MIN_VISITORS = 20;
export const BASELINE_DAYS = 7;
/** The cron runs every 5 minutes; nothing is checked more often. */
export const MIN_CHECK_MS = 5 * 60_000;
/** Payments listed per firing (the count says how many there were). */
export const MAX_PAYMENTS_PER_ALERT = 20;

export interface AlertRule {
  type: AlertType;
  window_minutes: number;
  threshold: number | null;
  min_visitors: number | null;
  goal: string | null;
}

/** How often a rule is evaluated: payments every run, the rest every quarter of the window (5-60 min). */
export function checkEveryMs(rule: Pick<AlertRule, "type" | "window_minutes">): number {
  if (rule.type === "payment") return MIN_CHECK_MS;
  return Math.min(60 * 60_000, Math.max(MIN_CHECK_MS, (rule.window_minutes * 60_000) / 4));
}

/** What the site's Durable Object reports for a rule (do/alerts.ts). */
export interface AlertNumbers {
  /** traffic: visitors in the window and in the same window on each of the days before */
  visitors?: number;
  baseline?: number[];
  /** no_data */
  last_event_at?: number | null;
  events?: number;
  /** goal */
  conversions?: number;
  /** payment */
  payments?: {
    id: string;
    type: string;
    amount: number;
    currency: string | null;
    ts: number;
    channel: string | null;
    source: string | null;
  }[];
  payment_count?: number;
  cursor?: number;
  /** visitor-sent context: top sources in the window */
  top_sources?: { value: unknown; visitors: number }[];
}

export interface AlertState {
  /** no_data: fired, waiting for data to come back */
  silent?: boolean;
  /** payment: created_at of the last payment already alerted */
  cursor?: number;
  last_value?: number | null;
  last_baseline?: number | null;
}

export interface Decision {
  fire: boolean;
  value: number | null;
  baseline: number | null;
  /** why it fires, or why not (for GET ?evaluate=true) */
  reason: string;
  state: AlertState;
}

const thresholdOf = (r: AlertRule) => r.threshold ?? ALERT_DEFAULTS[r.type].threshold;

export function decide(rule: AlertRule, n: AlertNumbers, prev: AlertState, now: number): Decision {
  const keep = { ...prev };
  switch (rule.type) {
    case "traffic_spike":
    case "traffic_drop": {
      const v = n.visitors ?? 0;
      const usual = median(n.baseline ?? []) ?? 0;
      const min = rule.min_visitors ?? DEFAULT_MIN_VISITORS;
      const t = thresholdOf(rule);
      const state = { ...keep, last_value: v, last_baseline: usual };
      if (rule.type === "traffic_spike") {
        const fire = v >= min && v >= t * Math.max(usual, 1);
        return {
          fire,
          value: v,
          baseline: usual,
          reason: fire
            ? `${v} visitors, ${usual ? `${Math.round((v / usual) * 10) / 10}x` : "far above"} the usual ${usual}`
            : v < min
              ? `${v} visitors, below min_visitors ${min}`
              : `${v} visitors, under ${t}x the usual ${usual}`,
          state,
        };
      }
      const floor = usual * (1 - t / 100);
      const fire = usual >= min && v <= floor;
      return {
        fire,
        value: v,
        baseline: usual,
        reason: fire
          ? `${v} visitors, ${Math.round((1 - v / Math.max(usual, 1)) * 100)}% below the usual ${usual}`
          : usual < min
            ? `the usual ${usual} visitors is below min_visitors ${min}`
            : `${v} visitors, above ${Math.round(floor * 10) / 10} (${t}% under the usual ${usual})`,
        state,
      };
    }
    case "no_data": {
      const events = n.events ?? 0;
      if (events > 0)
        return {
          fire: false,
          value: events,
          baseline: null,
          reason: `${events} events in the window`,
          state: { ...keep, silent: false, last_value: events },
        };
      if (n.last_event_at == null)
        return { fire: false, value: 0, baseline: null, reason: "the site has never received events", state: keep };
      if (prev.silent)
        return { fire: false, value: 0, baseline: null, reason: "already alerted; waiting for data to come back", state: keep };
      return {
        fire: true,
        value: 0,
        baseline: null,
        reason: `no events for ${Math.round((now - n.last_event_at) / 60_000)} minutes`,
        state: { ...keep, silent: true, last_value: 0 },
      };
    }
    case "goal": {
      const c = n.conversions ?? 0;
      const t = thresholdOf(rule);
      return { fire: c >= t, value: c, baseline: null, reason: `${c} conversions (threshold ${t})`, state: { ...keep, last_value: c } };
    }
    case "payment": {
      const count = n.payment_count ?? 0;
      const state = { ...keep, cursor: n.cursor ?? prev.cursor, last_value: count };
      return { fire: count > 0, value: count, baseline: null, reason: count ? `${count} new payments` : "no new payments", state };
    }
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const windowText = (minutes: number) =>
  minutes % 1440 === 0 ? plural(minutes / 1440, "day") : minutes % 60 === 0 ? plural(minutes / 60, "hour") : plural(minutes, "minute");

const LABEL: Record<AlertType, string> = {
  traffic_spike: "Traffic spike",
  traffic_drop: "Traffic drop",
  no_data: "No data",
  goal: "Goal",
  payment: "Payment",
};

const money = (amount: number, currency: string | null) => `${Math.round(amount * 100) / 100}${currency ? ` ${currency}` : ""}`;

/** Title (subject line) and plain-text lines of a firing. Visitor-sent strings are passed separately. */
export function alertText(
  rule: AlertRule & { name: string },
  domain: string,
  d: Pick<Decision, "value" | "baseline" | "reason">,
  n: AlertNumbers,
): { title: string; lines: string[] } {
  const w = windowText(rule.window_minutes);
  switch (rule.type) {
    case "traffic_spike":
    case "traffic_drop":
      return {
        title: `[${domain}] ${LABEL[rule.type]}: ${d.value} visitors in the last ${w}`,
        lines: [`${rule.name}: ${d.reason}.`, `The usual is the median of the same ${w} on each of the previous ${BASELINE_DAYS} days.`],
      };
    case "no_data":
      return {
        title: `[${domain}] No data: no events in the last ${w}`,
        lines: [`${rule.name}: ${d.reason}. Check that the tracker is still on the site (POST /verify).`],
      };
    case "goal":
      return { title: `[${domain}] Goal ${rule.goal}: ${d.value} conversions in the last ${w}`, lines: [`${rule.name}: ${d.reason}.`] };
    case "payment": {
      const p = n.payments ?? [];
      const total = p.reduce((a, x) => a + (x.type === "refund" ? -x.amount : x.amount), 0);
      return {
        title: `[${domain}] ${plural(n.payment_count ?? p.length, "payment")}${p.length ? ` (${money(total, p[0]!.currency)})` : ""}`,
        lines: p.map((x) => `${x.type} ${money(x.amount, x.currency)} at ${new Date(x.ts).toISOString()}`),
      };
    }
  }
}
