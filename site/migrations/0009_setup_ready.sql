-- What the last setup check found (src/notices.ts recordSetupCheck), so the setup reminder email
-- (src/email-messages.ts) knows a project isn't finished without running the check again.
-- ready: 1 when nothing was missing, failing or unavailable; todo: how many checks were.
ALTER TABLE setup_state ADD COLUMN ready INTEGER;
ALTER TABLE setup_state ADD COLUMN todo INTEGER;
