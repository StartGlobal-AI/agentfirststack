-- Attack protection per site: auto (default: a network's daily share always, data-centre traffic
-- quarantined while a spike lasts), strict (data-centre traffic always quarantined) or off.
ALTER TABLE sites ADD COLUMN protection TEXT NOT NULL DEFAULT 'auto';
