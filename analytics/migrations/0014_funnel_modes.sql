-- Wave 1, funnels v2. Forward-only and additive: the previous release never selects these columns.
-- mode: ordered (default) | any; conversion window: session (default) | 1h | 1d | 7d | 30d.
ALTER TABLE funnels ADD COLUMN mode TEXT NOT NULL DEFAULT 'ordered';
ALTER TABLE funnels ADD COLUMN window TEXT NOT NULL DEFAULT 'session';
