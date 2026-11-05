import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// Accounts and keys live in the shared identity DB; the app mirrors account rows into DB.
if (env.AUTH_DB) {
  await applyD1Migrations(env.AUTH_DB, env.TEST_AUTH_MIGRATIONS);
  // The site's project_notices table (its migration 0005_project_notices.sql on the hosted platform),
  // which every service reads: created here so the suite runs with it, as hosted does.
  await env.AUTH_DB.prepare(
    `CREATE TABLE IF NOT EXISTS project_notices (
       account_id   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
       notice       TEXT NOT NULL,
       owner_notice TEXT,
       created_at   INTEGER NOT NULL,
       shown_at     INTEGER
     )`,
  ).run();
}
