import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// The site's DB is the shared identity database (accounts, keys, users, OAuth).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
