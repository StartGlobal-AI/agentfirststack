import { applyD1Migrations, env } from "cloudflare:test";

// Runs before each integration test file: migrate the isolated D1 database.
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
// Accounts and keys live in the shared identity DB; the app mirrors account rows into DB.
const authDb = (env as unknown as { AUTH_DB?: D1Database }).AUTH_DB;
if (authDb)
  await applyD1Migrations(
    authDb,
    (env as unknown as { TEST_AUTH_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_AUTH_MIGRATIONS,
  );
