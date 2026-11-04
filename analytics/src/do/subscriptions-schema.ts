/** The subscriptions tables (schema version 8). No imports: the engine loads this at init. */

export const SUBSCRIPTIONS_SQL = [
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, external_id TEXT NOT NULL, customer TEXT,
    status TEXT NOT NULL, plan TEXT, currency TEXT, mrr REAL NOT NULL DEFAULT 0, price_mrr REAL NOT NULL DEFAULT 0,
    original_mrr REAL, original_currency TEXT, fx_rate REAL,
    interval TEXT, interval_count INTEGER, quantity INTEGER, trial_start INTEGER, trial_end INTEGER, started_at INTEGER,
    canceled_at INTEGER, ended_at INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    session_id TEXT, visitor_id TEXT, user_id TEXT, linked_by TEXT,
    channel TEXT, source TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, referrer TEXT, country TEXT,
    period_amount REAL, last_paid_at INTEGER, current_period_end INTEGER,
    livemode INTEGER NOT NULL DEFAULT 1, state_ts INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS subscriptions_status ON subscriptions(status)",
  "CREATE INDEX IF NOT EXISTS subscriptions_customer ON subscriptions(customer)",
  `CREATE TABLE IF NOT EXISTS subscription_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sub_ref TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
    mrr_before REAL NOT NULL, mrr_after REAL NOT NULL, status_after TEXT, currency TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS subscription_changes_ts ON subscription_changes(ts)",
  "CREATE INDEX IF NOT EXISTS subscription_changes_sub ON subscription_changes(sub_ref, ts)",
];
