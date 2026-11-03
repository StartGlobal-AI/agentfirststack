import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// Accounts and keys live in the shared identity DB; the app mirrors account rows into DB.
if (env.AUTH_DB) await applyD1Migrations(env.AUTH_DB, env.TEST_AUTH_MIGRATIONS);
