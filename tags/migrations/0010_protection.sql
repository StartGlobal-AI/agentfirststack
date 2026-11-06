-- Attack protection mode per container: NULL = auto (the network share always, attack measures
-- during a detected attack), 'strict' (attack measures all the time) or 'off'. Additive: existing
-- rows read as auto, and the previous release never reads the column.
ALTER TABLE containers ADD COLUMN protection TEXT;
