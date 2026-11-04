-- Wave 2: a site's reporting currency, and the ECB reference rates money is converted with.
-- Rates are units of the currency per 1 EUR (ECB's base), one row per published day.
ALTER TABLE sites ADD COLUMN currency TEXT;

CREATE TABLE IF NOT EXISTS fx_rates (
  day TEXT NOT NULL,
  currency TEXT NOT NULL,
  per_eur REAL NOT NULL,
  PRIMARY KEY (day, currency)
);
CREATE INDEX IF NOT EXISTS fx_rates_currency_day ON fx_rates(currency, day);

-- When the cron last tried to fetch rates (one row per key).
CREATE TABLE IF NOT EXISTS fx_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
