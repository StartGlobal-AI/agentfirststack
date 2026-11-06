#!/usr/bin/env node
// AgentFirstStack deployment tool. One deployment = one profile file, deploy/<profile>.json.
//
//   pnpm afs init <profile> --domain example.com --account <cloudflare-account-id> [--prefix afs]
//   pnpm afs config <profile>              write <app>/wrangler.deploy.json from the profile
//   pnpm afs deploy <profile> [app ...]    config + D1 migrations + wrangler deploy + secrets
//   pnpm afs email <profile>               Email Routing catch-all + Email Sending for the mail domain
//   pnpm afs check <profile>               end-to-end check of a live deployment (cleans up after itself)
//   pnpm afs suspend <profile> <acct_id> --reason "..."   stop an abusive account: every key, every service
//   pnpm afs unsuspend <profile> <acct_id>                undo a suspension
//   pnpm afs pause <profile> <acct_id> <capability> --reason "..."   pause one capability (mail.send, ...)
//   pnpm afs unpause <profile> <acct_id> <capability>     lift a capability pause (automatic or by hand)
//   pnpm afs restore <profile> <acct_id>                  undo a project deletion (before its purge, 7 days)
//   pnpm afs email-test <profile> <address>               send the welcome email to someone who signed in
//   pnpm afs digest <profile>                             send the operator's daily summary now (OPERATOR_EMAIL) and print it
//   pnpm afs zone-rules <profile> [--save]                compare the zone's security rules with the profile's zone_rules
//                                                         (CLOUDFLARE_WAF_TOKEN: Zone WAF Read); --save records the live ones
//
// Each app's wrangler.jsonc is the generic template (local dev, tests, self-host defaults). This
// script never edits it; it derives a deploy config per app from the template plus the profile.
// Secrets live in deploy/<profile>.secrets.json, which is git-ignored and created by `init`.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = ["site", "analytics", "tags", "mail", "replay"];
const DEPLOY_FILE = "wrangler.deploy.json";

// ---------- helpers ----------

function die(msg) {
  console.error(`\n✘ ${msg}`);
  process.exit(1);
}
const log = (msg) => console.log(msg);

/** Parse JSON with // and /* comments and trailing commas (wrangler.jsonc). */
export function parseJsonc(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function args(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      opts[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    } else pos.push(a);
  }
  return { pos, opts };
}

const profilePath = (name) => join(ROOT, "deploy", `${name}.json`);
const secretsPath = (name) => join(ROOT, "deploy", `${name}.secrets.json`);

function loadProfile(name) {
  if (!name || !/^[a-z0-9-]+$/.test(name)) die("Give a profile name (lowercase letters, digits, dashes), e.g. `pnpm afs deploy hosted`.");
  const p = profilePath(name);
  if (!existsSync(p)) die(`No deploy/${name}.json. Create one with: pnpm afs init ${name} --domain example.com --account <account-id>`);
  return { name, ...JSON.parse(readFileSync(p, "utf8")) };
}

function saveProfile(profile) {
  const { name, ...rest } = profile;
  mkdirSync(join(ROOT, "deploy"), { recursive: true });
  writeFileSync(profilePath(name), `${JSON.stringify(rest, null, 2)}\n`);
}

function loadSecrets(name) {
  const p = secretsPath(name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** Run wrangler from an app directory (uses the workspace's pinned wrangler). */
function wrangler(app, wargs, { capture = false, account, input } = {}) {
  const r = spawnSync("pnpm", ["exec", "wrangler", ...wargs], {
    cwd: join(ROOT, app),
    env: { ...process.env, ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}) },
    stdio: capture ? ["pipe", "pipe", "pipe"] : [input ? "pipe" : "inherit", "inherit", "inherit"],
    input: input ?? (capture ? "" : undefined),
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ---------- naming: everything derives from the profile's prefix and domain ----------

function names(profile) {
  const p = profile.prefix || "afs";
  return {
    worker: (app) => `${p}-${app}`,
    d1: { identity: `${p}-identity`, analytics: `${p}-analytics`, tags: `${p}-tags`, mail: `${p}-mail`, replay: `${p}-replay` },
    mailBlobs: `${p}-mail-blobs`,
    // R2 bucket per app that has one: mail's message blobs, replay's recording chunks.
    r2: { mail: `${p}-mail-blobs`, replay: `${p}-replay-chunks` },
    queues: { tags: `${p}-tags-dispatch`, mail: `${p}-mail-webhooks` },
  };
}

const hostOf = (profile, app) => (app === "site" ? profile.domain : `${app}.${profile.domain}`);

/**
 * Paths each app serves on the user-content domain, as Worker route patterns: the share pages of
 * analytics and replay, and the rest of the host for the site (a page saying what the domain is,
 * robots.txt, 404). The more specific route wins, so /a/* and /r/* stay with their apps.
 */
export const USER_CONTENT_PATHS = { analytics: "/a/*", replay: "/r/*", site: "/*" };

/** profile.user_content_domain, a bare hostname (a zone apex in the account), or null. */
function userContentDomain(profile) {
  const d = String(profile.user_content_domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!d) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) die(`deploy/${profile.name}.json: user_content_domain "${d}" is not a hostname.`);
  if (d === profile.domain || d.endsWith(`.${profile.domain}`))
    die(`deploy/${profile.name}.json: user_content_domain must be a domain of its own, not ${profile.domain} or under it.`);
  return d;
}

/** The deploy config for one app: its template with the profile's account, names, ids and vars. */
export function buildConfig(profile, app, template) {
  const n = names(profile);
  const cfg = structuredClone(template);
  cfg.name = n.worker(app);
  cfg.account_id = profile.account_id;
  cfg.routes =
    app === "site"
      ? [
          { pattern: profile.domain, custom_domain: true },
          { pattern: `www.${profile.domain}`, custom_domain: true },
        ]
      : [{ pattern: hostOf(profile, app), custom_domain: true }];
  // The user-content domain (profile.user_content_domain): share pages of replay (/r/*) and
  // analytics (/a/*) on a zone of their own, by Worker routes (a custom domain is one Worker per
  // host). Listed here because wrangler deploy replaces a Worker's routes with the config's.
  const uc = userContentDomain(profile);
  if (uc && USER_CONTENT_PATHS[app]) cfg.routes.push({ pattern: `${uc}${USER_CONTENT_PATHS[app]}`, zone_name: uc });
  // Only the custom domains: a *.workers.dev or preview URL would skip the zone's WAF and
  // rate-limit rules.
  cfg.workers_dev = false;
  cfg.preview_urls = false;

  cfg.d1_databases = (template.d1_databases ?? []).map((db) => {
    const key = app === "site" || db.binding === "AUTH_DB" ? "identity" : app;
    const id = profile.resources?.d1?.[key];
    if (!id) die(`deploy/${profile.name}.json has no resources.d1.${key}. Run \`pnpm afs init ${profile.name} ...\` to create it.`);
    return { ...db, database_name: n.d1[key], database_id: id };
  });
  if (template.r2_buckets) {
    if (!n.r2[app]) die(`${app}/wrangler.jsonc declares an R2 bucket, but the deploy tool has no bucket name for "${app}".`);
    cfg.r2_buckets = template.r2_buckets.map((b) => ({ ...b, bucket_name: n.r2[app] }));
  }
  if (template.queues) {
    const q = n.queues[app];
    cfg.queues = {
      producers: (template.queues.producers ?? []).map((x) => ({ ...x, queue: q })),
      consumers: (template.queues.consumers ?? []).map((x) => ({ ...x, queue: q, dead_letter_queue: `${q}-dlq` })),
    };
  }
  if (template.services) {
    // Service bindings point at this deployment's own Workers: afs-analytics -> <prefix>-analytics.
    cfg.services = template.services.map((s) => ({ ...s, service: n.worker(s.service.replace(/^[a-z0-9]+-/, "")) }));
  }
  // SIGNUP_LIMITER is one counter shared by every app (signup works on all of them), so it takes
  // the profile's namespace. Every other limiter keeps its own namespace id from the template:
  // a namespace is one counter space, and two limiters sharing one would count each other's hits.
  if (template.ratelimits && profile.ratelimit_namespace) {
    cfg.ratelimits = template.ratelimits.map((r) =>
      r.name === "SIGNUP_LIMITER" ? { ...r, namespace_id: String(profile.ratelimit_namespace) } : r,
    );
  }

  // AUTH_ISSUER: the OAuth authorization server (the site) that every app's RFC 9728 metadata names.
  const derived = { PUBLIC_BASE_URL: `https://${hostOf(profile, app)}`, AUTH_ISSUER: `https://${profile.domain}` };
  if (app === "tags") derived.ANALYTICS_BASE_URL = `https://${hostOf(profile, "analytics")}`;
  // The analytics tracker loads the replay recorder on sites linked to a replay site.
  if (app === "analytics") derived.REPLAY_BASE_URL = `https://${hostOf(profile, "replay")}`;
  if (uc && USER_CONTENT_PATHS[app]) derived.USER_CONTENT_BASE_URL = `https://${uc}`;
  if (app === "mail") {
    derived.MAIL_DOMAIN = profile.mail_domain || profile.domain;
    // A second shared domain new inboxes go to (MAIL_DOMAIN keeps working); its own zone apex.
    if (profile.shared_inbox_domain) derived.SHARED_INBOX_DOMAIN = String(profile.shared_inbox_domain).toLowerCase();
    derived.WORKER_NAME = n.worker("mail");
  }
  // First-party domains (Cloudflare for SaaS): the site Worker serves them; customers CNAME to
  // fp.<domain>. Both stay inert until the profile sets CF_SAAS_ZONE_ID and the secrets file
  // site.CF_SAAS_API_TOKEN (docs/self-hosting.md, First-party domains).
  if (app === "site") {
    derived.CF_SAAS_WORKER = n.worker("site");
    derived.CF_SAAS_FALLBACK_HOST = `fp.${profile.domain}`;
  }
  cfg.vars = { ...(template.vars ?? {}), ...derived, ...(profile.vars?.all ?? {}), ...(profile.vars?.[app] ?? {}) };
  return cfg;
}

function writeConfigs(profile, apps = APPS) {
  for (const app of apps) {
    const template = parseJsonc(readFileSync(join(ROOT, app, "wrangler.jsonc"), "utf8"));
    const cfg = buildConfig(profile, app, template);
    const header = {
      $comment: `Generated by \`pnpm afs config ${profile.name}\` from wrangler.jsonc + deploy/${profile.name}.json. Do not edit.`,
    };
    writeFileSync(join(ROOT, app, DEPLOY_FILE), `${JSON.stringify({ ...header, ...cfg }, null, 2)}\n`);
    log(`  ${app}/${DEPLOY_FILE}  ->  ${cfg.name} on ${cfg.routes.map((r) => r.pattern).join(", ")}`);
  }
}

/**
 * The secrets one app gets: INTERNAL_TOKEN (top level, every app); ADMIN_TOKEN (top level) only
 * where an operator uses it (the site: admin API and signups past the limits; mail: domain
 * auto-configure), so a leak from another app exposes less; the site's GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET (top level or under "site"); then the app's own block.
 */
export const ADMIN_APPS = ["site", "mail"];
export function secretsFor(secrets, app) {
  const out = {};
  if (secrets.INTERNAL_TOKEN) out.INTERNAL_TOKEN = secrets.INTERNAL_TOKEN;
  if (secrets.ADMIN_TOKEN && ADMIN_APPS.includes(app)) out.ADMIN_TOKEN = secrets.ADMIN_TOKEN;
  if (app === "site") for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) if (secrets[k]) out[k] = secrets[k];
  return { ...out, ...(secrets[app] ?? {}) };
}

// ---------- commands ----------

async function cmdInit(name, opts) {
  const existing = existsSync(profilePath(name)) ? loadProfile(name) : null;
  const profile = existing ?? { name };
  if (opts.domain) profile.domain = String(opts.domain).toLowerCase();
  if (opts.account) profile.account_id = String(opts.account);
  if (opts.prefix) profile.prefix = String(opts.prefix);
  if (opts["mail-domain"]) profile.mail_domain = String(opts["mail-domain"]);
  profile.prefix ||= "afs";
  if (!profile.domain || !profile.account_id)
    die("init needs --domain <your-domain.com> and --account <cloudflare-account-id> (wrangler whoami lists it).");
  profile.resources ??= {};
  profile.resources.d1 ??= {};
  const n = names(profile);
  const acct = profile.account_id;

  log(`Creating resources in account ${acct} with prefix "${profile.prefix}" (existing ones are reused)...`);
  for (const [key, dbName] of Object.entries(n.d1)) {
    if (profile.resources.d1[key]) {
      log(`  d1 ${dbName}: ${profile.resources.d1[key]} (from profile)`);
      continue;
    }
    let info = wrangler("site", ["d1", "info", dbName, "--json"], { capture: true, account: acct });
    if (!info.ok) {
      const c = wrangler("site", ["d1", "create", dbName], { capture: true, account: acct });
      if (!c.ok) die(`wrangler d1 create ${dbName} failed:\n${c.out}`);
      info = wrangler("site", ["d1", "info", dbName, "--json"], { capture: true, account: acct });
    }
    const uuid = (info.out.match(/"uuid":\s*"([0-9a-f-]{36})"/) ?? [])[1];
    if (!uuid) die(`Could not read the id of D1 database ${dbName}:\n${info.out}`);
    profile.resources.d1[key] = uuid;
    log(`  d1 ${dbName}: ${uuid}`);
  }
  const ensure = (kind, wargs, label) => {
    const r = wrangler("site", wargs, { capture: true, account: acct });
    const fine = r.ok || /already exists|already taken/i.test(r.out);
    if (!fine) die(`${kind} ${label} failed:\n${r.out}`);
    log(`  ${kind} ${label}: ${r.ok ? "created" : "exists"}`);
  };
  for (const bucket of Object.values(n.r2)) ensure("r2", ["r2", "bucket", "create", bucket], bucket);
  for (const q of Object.values(n.queues)) {
    ensure("queue", ["queues", "create", q], q);
    ensure("queue", ["queues", "create", `${q}-dlq`], `${q}-dlq`);
  }

  profile.vars ??= { all: { SIGNUP_MODE: "open", KEY_PREFIX: profile.prefix } };
  saveProfile(profile);
  log(`\nWrote deploy/${name}.json`);

  const existingSecrets = loadSecrets(name);
  const b64 = () => randomBytes(32).toString("base64");
  // Every generated secret. Running init again on an existing profile adds the ones a newer
  // release introduced (INTERNAL_TOKEN for the dashboard, analytics' ENCRYPTION_KEY for Stripe)
  // and never changes one that is already set.
  const generated = {
    ADMIN_TOKEN: () => randomBytes(32).toString("hex"),
    // Shared by all Workers: the site's dashboard reads resources from the services with it.
    INTERNAL_TOKEN: () => randomBytes(32).toString("hex"),
    "analytics.SALT_SECRET": b64,
    "analytics.ENCRYPTION_KEY": b64,
    "tags.ENCRYPTION_KEY": b64,
    "mail.ENCRYPTION_KEY": b64,
    "replay.ENCRYPTION_KEY": b64,
  };
  const secrets = existingSecrets ?? {};
  const added = [];
  for (const [path, make] of Object.entries(generated)) {
    const [scope, key] = path.includes(".") ? path.split(".") : [null, path];
    const target = scope ? (secrets[scope] ??= {}) : secrets;
    if (!target[key]) {
      target[key] = make();
      added.push(path);
    }
  }
  if (!existingSecrets) {
    writeFileSync(secretsPath(name), `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    log(`Wrote deploy/${name}.secrets.json (git-ignored; keep it safe: losing ENCRYPTION_KEY makes stored credentials unreadable)`);
  } else if (added.length) {
    writeFileSync(secretsPath(name), `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    log(`Added ${added.join(", ")} to deploy/${name}.secrets.json`);
  }
  log(
    'Optional: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET under "site" in the secrets file turn on Sign in with Google (docs/accounts.md).',
  );
  log(`\nNext: pnpm afs deploy ${name}   then   pnpm afs email ${name}`);
}

function cmdConfig(name) {
  const profile = loadProfile(name);
  log(`Writing deploy configs for "${name}":`);
  writeConfigs(profile);
}

function cmdDeploy(name, apps, opts) {
  const profile = loadProfile(name);
  const secrets = loadSecrets(name);
  if (!secrets && !opts["skip-secrets"])
    die(`No deploy/${name}.secrets.json. Run \`pnpm afs init ${name}\` (it generates one) or pass --skip-secrets.`);
  const targets = apps.length ? apps : APPS;
  for (const a of targets) if (!APPS.includes(a)) die(`Unknown app "${a}". Apps: ${APPS.join(", ")}`);
  writeConfigs(profile, targets);
  if (secrets && !opts["skip-secrets"] && !secrets.INTERNAL_TOKEN) {
    log(`! deploy/${name}.secrets.json has no INTERNAL_TOKEN: the dashboard can't list resources. \`pnpm afs init ${name}\` adds one.`);
  }
  // Identity first: every app authenticates against it.
  const order = APPS.filter((a) => targets.includes(a));
  for (const app of order) {
    log(`\n━━ ${app}`);
    const cfg = JSON.parse(readFileSync(join(ROOT, app, DEPLOY_FILE), "utf8"));
    for (const db of cfg.d1_databases ?? []) {
      if (!db.migrations_dir) continue;
      const apply = () => wrangler(app, ["d1", "migrations", "apply", db.binding, "--remote", "-c", DEPLOY_FILE], { input: "y\ny\ny\n" });
      let m = apply();
      // The first D1 call of a run sometimes fails with 7403 ("account is not valid or is not
      // authorized") while wrangler's OAuth token refreshes; the same call succeeds right after.
      if (!m.ok) {
        log(`! Migrations for ${app} ${db.binding} failed; retrying once.`);
        m = apply();
      }
      if (!m.ok) die(`Migrations for ${app} ${db.binding} failed.`);
    }
    if (!wrangler(app, ["deploy", "-c", DEPLOY_FILE]).ok) die(`wrangler deploy failed for ${app}.`);
    if (secrets && !opts["skip-secrets"]) {
      const appSecrets = secretsFor(secrets, app);
      if (Object.keys(appSecrets).length) {
        const f = join(tmpdir(), `afs-${name}-${app}-${process.pid}.json`);
        writeFileSync(f, JSON.stringify(appSecrets), { mode: 0o600 });
        const s = wrangler(app, ["secret", "bulk", f, "-c", DEPLOY_FILE]);
        rmSync(f, { force: true });
        if (!s.ok) die(`Setting secrets for ${app} failed.`);
      }
    }
  }
  log(`\n✔ Deployed ${order.join(", ")}. Check it: pnpm afs check ${name}`);
}

async function cf(token, method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: !!j.success, result: j.result, errors: j.errors ?? [{ message: `HTTP ${res.status}` }] };
}

async function cmdEmail(name) {
  const profile = loadProfile(name);
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    die(
      "Set CLOUDFLARE_API_TOKEN to a token with Zone Read, Zone Settings Edit, Email Routing Rules Edit and Email Sending Edit on the mail domain's zone (and on shared_inbox_domain's zone when the profile has one).",
    );
  }
  const worker = names(profile).worker("mail");
  // The shared domains: mail_domain (or the apex), and shared_inbox_domain, where new inboxes go.
  const domains = [
    ...new Set([profile.mail_domain || profile.domain, profile.shared_inbox_domain].filter(Boolean).map((d) => String(d).toLowerCase())),
  ];
  for (const domain of domains) await emailSetup(token, domain, worker);
  log("\nReceiving works once MX has propagated; sending once the status above is ready.");
  if (profile.shared_inbox_domain)
    log(
      `Once Email Sending for ${profile.shared_inbox_domain} is ready, list it in vars.mail.SHARED_SENDING_DOMAINS (e.g. "${domains.join(",")}") and \`pnpm afs deploy ${name} mail\`: until then its inboxes receive, but mail to outside addresses is refused (503 domain_not_onboarded).`,
    );
}

/** Email Routing (catch-all -> the mail Worker) and Email Sending for one shared domain (a zone apex). */
async function emailSetup(token, domain, worker) {
  const zone = await cf(token, "GET", `/zones?name=${encodeURIComponent(domain)}`);
  const zoneId = zone.result?.[0]?.id;
  if (!zoneId) die(`Zone ${domain} not found for this token. A shared mail domain must be a zone in your Cloudflare account (its apex).`);
  log(`Zone ${domain} (${zoneId})`);

  const routing = await cf(token, "GET", `/zones/${zoneId}/email/routing`);
  if (!routing.result?.enabled) {
    const en = await cf(token, "POST", `/zones/${zoneId}/email/routing/dns`, {});
    log(`  Email Routing: ${en.ok ? "enabled (MX + SPF records added)" : `FAILED ${JSON.stringify(en.errors)}`}`);
  } else log("  Email Routing: already enabled");

  const rule = await cf(token, "PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
    name: `All mail to ${worker}`,
    enabled: true,
    matchers: [{ type: "all" }],
    actions: [{ type: "worker", value: [worker] }],
  });
  log(`  Catch-all -> ${worker}: ${rule.ok ? "set" : `FAILED ${JSON.stringify(rule.errors)}`}`);

  const subs = await cf(token, "GET", `/zones/${zoneId}/email/sending/subdomains`);
  let sub = (subs.result ?? []).find((s) => s.name === domain);
  if (!sub) {
    const created = await cf(token, "POST", `/zones/${zoneId}/email/sending/subdomains`, { name: domain });
    if (!created.ok) die(`Email Sending onboarding of ${domain} failed: ${JSON.stringify(created.errors)} (needs the Workers Paid plan).`);
    sub = created.result;
  }
  await cf(token, "POST", `/zones/${zoneId}/email/sending/subdomains/${sub.id}/dns`, {});
  const status = await cf(token, "GET", `/zones/${zoneId}/email/sending/subdomains/${sub.id}/dns/status`);
  log(
    `  Email Sending for ${domain}: ${status.result?.status ?? "unknown"}${status.result?.errors?.length ? ` ${JSON.stringify(status.result.errors)}` : ""}`,
  );
}

async function cmdCheck(name) {
  const profile = loadProfile(name);
  const base = (app) => `https://${hostOf(profile, app)}`;
  const results = [];
  const step = (label, ok, detail = "") => {
    results.push(ok);
    log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  };
  const call = async (url, init = {}) => {
    try {
      const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, text };
    } catch (e) {
      return { status: 0, json: null, text: String(e) };
    }
  };
  log(`Checking ${profile.domain}:`);
  for (const [label, url] of [
    ["landing page", `${base("site")}/`],
    ["platform manual", `${base("site")}/llms.txt`],
    ...["analytics", "tags", "mail", "replay"].map((a) => [`${a} manual`, `${base(a)}/llms.txt`]),
  ]) {
    const r = await call(url);
    step(label, r.status === 200, url);
  }
  // The operator's ADMIN_TOKEN skips signup limits, so running the check never uses up a real
  // network's daily allowance (or trips the deployment-wide breaker).
  const admin = loadSecrets(name)?.ADMIN_TOKEN;
  const su = await call(`${base("site")}/v1/signup`, {
    method: "POST",
    headers: admin ? { authorization: `Bearer ${admin}` } : {},
    body: JSON.stringify({ name: "afs-check" }),
  });
  const key = su.json?.api_key;
  step("signup returns a key", su.status === 201 && !!key, key ? `${key.slice(0, 5)}...` : su.text.slice(0, 120));
  if (!key) return finish();
  const H = { authorization: `Bearer ${key}` };
  const dom = `afs-check-${Date.now()}.example`;
  const site = await call(`${base("analytics")}/v1/sites`, { method: "POST", headers: H, body: JSON.stringify({ domain: dom }) });
  step("analytics: create site with the shared key", !!site.json?.site?.id);
  const ctr = await call(`${base("tags")}/v1/containers`, { method: "POST", headers: H, body: JSON.stringify({ domain: dom }) });
  step("tags: create container with the shared key", !!ctr.json?.container?.id);
  const inbox = await call(`${base("mail")}/v1/inboxes`, { method: "POST", headers: H, body: JSON.stringify({}) });
  step("mail: create inbox with the shared key", !!inbox.json?.inbox?.id, inbox.json?.inbox?.address ?? "");
  if (profile.shared_inbox_domain) {
    const want = `@${String(profile.shared_inbox_domain).toLowerCase()}`;
    step(`mail: new inboxes go on ${want.slice(1)}`, String(inbox.json?.inbox?.address ?? "").endsWith(want));
  }
  // Linked to the analytics site: its tracker loads the recorder, so there's no second snippet.
  const rsite = await call(`${base("replay")}/v1/sites`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ domain: dom, analytics_site_id: site.json?.site?.id }),
  });
  step("replay: create site with the shared key", !!rsite.json?.site?.id);
  step("replay: linked analytics site loads the recorder", rsite.json?.site?.loads_with_analytics === true);
  if (site.json?.site?.id && rsite.json?.site?.id) {
    const pv = await call(`${base("analytics")}/e`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ s: site.json.site.id, n: "pageview", u: `https://${dom}/` }),
    });
    const want = `${base("replay")}/r/${rsite.json.site.id}.js`;
    step("analytics: tracker answer names the replay loader", pv.json?.r === want, pv.json?.r ?? `HTTP ${pv.status}`);
  }
  // The user-content domain: each route reaches its Worker, which serves only share pages there.
  const uc = userContentDomain(profile);
  if (uc) {
    const nil = "0".repeat(32);
    const a = await call(`https://${uc}/a/shr_${nil}`);
    step(`analytics: ${uc}/a/* reaches the share pages`, a.status === 404 && a.json?.error?.code === "not_found", `HTTP ${a.status}`);
    const r = await call(`https://${uc}/r/rpt_${nil}`);
    step(`replay: ${uc}/r/* reaches the share player`, r.status === 404 && r.text.includes("expired or was revoked"), `HTTP ${r.status}`);
    const api = await call(`https://${uc}/a/v1/sites`, { headers: H });
    step(`${uc} serves no API`, api.status === 404 && !api.json?.sites, `HTTP ${api.status}`);
    const root = await call(`https://${uc}/`);
    step(`site: ${uc}/ says what the domain is`, root.status === 200 && root.text.includes("/report-abuse"), `HTTP ${root.status}`);
    const other = await call(`https://${uc}/v1/usage`, { headers: H });
    step(`site: ${uc} serves nothing of the platform`, other.status === 404 && !other.json, `HTTP ${other.status}`);
  }
  const as = await call(`${base("site")}/.well-known/oauth-authorization-server`);
  step("OAuth authorization server metadata", as.json?.issuer === base("site"), as.json?.issuer ?? `HTTP ${as.status}`);
  for (const app of APPS) {
    const prm = await call(`${base(app)}/.well-known/oauth-protected-resource/mcp`);
    step(`${app}: protected resource metadata names it`, prm.json?.authorization_servers?.[0] === base("site"));
  }
  const claim = await call(`${base("site")}/v1/claim-link`, { method: "POST", headers: H });
  step("claim link", claim.status === 201 && String(claim.json?.url ?? "").startsWith(`${base("site")}/claim/`));
  for (const app of ["analytics", "tags", "mail", "replay"]) {
    const t = await call(`${base(app)}/mcp`, {
      method: "POST",
      headers: { ...H, accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const count = t.json?.result?.tools?.length ?? 0;
    const why = count
      ? ""
      : ` (HTTP ${t.status}${t.json?.error ? `: ${JSON.stringify(t.json.error).slice(0, 200)}` : t.json ? "" : `: ${t.text.slice(0, 200)}`})`;
    step(`${app}: MCP tools/list`, count > 0, `${count} tools${why}`);
  }
  // Clean up everything this check created (replay first: deleting it unlinks the analytics site).
  if (rsite.json?.site?.id) await call(`${base("replay")}/v1/sites/${rsite.json.site.id}`, { method: "DELETE", headers: H });
  if (site.json?.site?.id) await call(`${base("analytics")}/v1/sites/${site.json.site.id}`, { method: "DELETE", headers: H });
  if (ctr.json?.container?.id) await call(`${base("tags")}/v1/containers/${ctr.json.container.id}`, { method: "DELETE", headers: H });
  if (inbox.json?.inbox?.id) await call(`${base("mail")}/v1/inboxes/${inbox.json.inbox.id}`, { method: "DELETE", headers: H });
  const me = await call(`${base("site")}/v1/me`, { headers: H });
  if (me.json?.key?.id) await call(`${base("site")}/v1/keys/${me.json.key.id}`, { method: "DELETE", headers: H });
  step("cleaned up and revoked the check key", true);
  // The zone's security rules run before the Workers; compare them with what the profile expects.
  if (profile.zone_rules && process.env.CLOUDFLARE_WAF_TOKEN) {
    const z = await zoneRulesDrift(profile, process.env.CLOUDFLARE_WAF_TOKEN);
    step("zone security rules match the profile", !z.error && !z.drift.length, z.error ?? z.drift.join("; "));
  } else
    log(
      `  skip zone security rules  ${profile.zone_rules ? "set CLOUDFLARE_WAF_TOKEN (Zone WAF Read)" : "no zone_rules in the profile (pnpm afs zone-rules <profile> --save)"}`,
    );
  return finish();

  function finish() {
    const failed = results.filter((x) => !x).length;
    log(failed ? `\n✘ ${failed} check(s) failed` : "\n✔ All checks passed");
    process.exit(failed ? 1 : 0);
  }
}

// ---------- operator: suspend / unsuspend ----------

const ACCOUNT_ID = /^acct_[0-9a-z]{1,64}$/;

/**
 * POST /v1/admin/accounts/:id/suspend (or /unsuspend) on the site, with the ADMIN_TOKEN as Bearer.
 * Returns the API's JSON body; throws with the API's message and hint when it refuses.
 */
export async function setSuspension({ base, token, accountId, suspend, reason }) {
  if (!ACCOUNT_ID.test(accountId ?? "")) throw new Error("Give the account id (acct_...). GET /v1/me shows it for a key.");
  if (suspend && !reason?.trim()) throw new Error('Say why with --reason "..." (it is stored with the suspension).');
  const res = await fetch(`${base.replace(/\/+$/, "")}/v1/admin/accounts/${accountId}/${suspend ? "suspend" : "unsuspend"}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(suspend ? { reason: reason.trim() } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const e = json?.error;
    throw new Error(e ? `${res.status} ${e.code}: ${e.message}${e.hint ? ` ${e.hint}` : ""}` : `HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function cmdSuspend(name, accountId, opts, suspend) {
  const profile = loadProfile(name);
  const token = loadSecrets(name)?.ADMIN_TOKEN;
  if (!token) die(`deploy/${name}.secrets.json has no ADMIN_TOKEN. \`pnpm afs init ${name}\` adds one; deploy before using it.`);
  let out;
  try {
    out = await setSuspension({
      base: `https://${profile.domain}`,
      token,
      accountId,
      suspend,
      reason: typeof opts.reason === "string" ? opts.reason : "",
    });
  } catch (e) {
    die(e.message);
  }
  const a = out.account;
  log(
    `${suspend ? "Suspended" : "Unsuspended"} ${a.id}${out.existing ? " (it already was)" : ""}: ${a.name ?? "unnamed"}, ${a.active_keys} active keys, ${a.members} members.`,
  );
  if (a.suspended_reason) log(`  reason: ${a.suspended_reason}`);
  for (const step of out.next_steps ?? []) log(`  - ${step}`);
}

// ---------- operator: capability pauses ----------

const CAPABILITIES = ["mail.send", "mail.inbox_create", "tags.custom_code", "replay.share_links", "analytics.share_links"];

/**
 * POST /v1/admin/accounts/:id/pauses (pause) or DELETE .../pauses/:capability (lift) on the site,
 * with the ADMIN_TOKEN as Bearer. Returns the API's JSON body; throws with its message and hint.
 */
export async function setPause({ base, token, accountId, capability, pause, reason }) {
  if (!ACCOUNT_ID.test(accountId ?? "")) throw new Error("Give the account id (acct_...). GET /v1/me shows it for a key.");
  if (!CAPABILITIES.includes(capability)) throw new Error(`Give the capability: one of ${CAPABILITIES.join(", ")}.`);
  if (pause && !reason?.trim()) throw new Error('Say why with --reason "..." (the project\'s people read it).');
  const url = `${base.replace(/\/+$/, "")}/v1/admin/accounts/${accountId}/pauses${pause ? "" : `/${capability}`}`;
  const res = await fetch(url, {
    method: pause ? "POST" : "DELETE",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: pause ? JSON.stringify({ capability, reason: reason.trim() }) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const e = json?.error;
    throw new Error(e ? `${res.status} ${e.code}: ${e.message}${e.hint ? ` ${e.hint}` : ""}` : `HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function cmdPause(name, accountId, capability, opts, pause) {
  const profile = loadProfile(name);
  const token = loadSecrets(name)?.ADMIN_TOKEN;
  if (!token) die(`deploy/${name}.secrets.json has no ADMIN_TOKEN. \`pnpm afs init ${name}\` adds one; deploy before using it.`);
  let out;
  try {
    out = await setPause({
      base: `https://${profile.domain}`,
      token,
      accountId,
      capability,
      pause,
      reason: typeof opts.reason === "string" ? opts.reason : "",
    });
  } catch (e) {
    die(e.message);
  }
  if (pause) log(`${out.existing ? "Already paused" : "Paused"}: ${capability} for ${accountId} (${out.pause?.reason ?? ""}).`);
  else log(`${out.lifted ? "Lifted" : "Wasn't paused"}: ${capability} for ${accountId}.`);
  for (const step of out.next_steps ?? []) log(`  - ${step}`);
}

/** POST /v1/admin/accounts/:id/restore: undo a project deletion before the purge erases it. */
async function cmdRestore(name, accountId) {
  if (!ACCOUNT_ID.test(accountId ?? "")) die("Give the project id (acct_...).");
  const profile = loadProfile(name);
  const token = loadSecrets(name)?.ADMIN_TOKEN;
  if (!token) die(`deploy/${name}.secrets.json has no ADMIN_TOKEN. \`pnpm afs init ${name}\` adds one; deploy before using it.`);
  const res = await fetch(`https://${profile.domain}/v1/admin/accounts/${accountId}/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    die(e ? `${res.status} ${e.code}: ${e.message}${e.hint ? ` ${e.hint}` : ""}` : `HTTP ${res.status}`);
  }
  const a = json.account;
  log(
    `${json.restored ? "Restored" : "Not deleted, nothing to restore:"} ${a.id}: ${a.name ?? "unnamed"}, ${a.active_keys} active keys, ${a.members} members.`,
  );
  for (const step of json.next_steps ?? []) log(`  - ${step}`);
}

/** POST /v1/admin/emails/test: one real email, to check sending end to end. */
async function cmdEmailTest(name, address) {
  if (!address?.includes("@")) die("Give the email address of someone who has signed in.");
  const profile = loadProfile(name);
  const token = loadSecrets(name)?.ADMIN_TOKEN;
  if (!token) die(`deploy/${name}.secrets.json has no ADMIN_TOKEN.`);
  const res = await fetch(`https://${profile.domain}/v1/admin/emails/test`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ email: address }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    die(e ? `${res.status} ${e.code}: ${e.message}${e.hint ? ` ${e.hint}` : ""}` : `HTTP ${res.status}`);
  }
  log(
    `${json.result}: ${json.email?.status ?? "?"}${json.email?.error ? ` (${json.email.error})` : ""}${json.email?.message_id ? ` ${json.email.message_id}` : ""}`,
  );
}

async function cmdDigest(name) {
  const profile = loadProfile(name);
  const token = loadSecrets(name)?.ADMIN_TOKEN;
  if (!token) die(`deploy/${name}.secrets.json has no ADMIN_TOKEN.`);
  const res = await fetch(`https://${profile.domain}/v1/admin/digest`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    die(e ? `${res.status} ${e.code}: ${e.message}${e.hint ? ` ${e.hint}` : ""}` : `HTTP ${res.status}`);
  }
  log(JSON.stringify(json.digest, null, 2));
  log(`email: ${JSON.stringify(json.email)}`);
}

// ---------- zone security rules ----------

const ZONE_PHASES = ["http_ratelimit", "http_request_firewall_custom"];

/** The zone's rate-limit and custom rules, reduced to what matters (ids and timestamps dropped). */
async function liveZoneRules(profile, token) {
  // profile.zone_id spares the token Zone Read (a WAF Read token can't list zones).
  const zone = profile.zone_id ? null : await cf(token, "GET", `/zones?name=${encodeURIComponent(profile.domain)}`);
  const zoneId = profile.zone_id ?? zone?.result?.[0]?.id;
  if (!zoneId)
    return {
      error: `zone ${profile.domain} not found for this token: add "zone_id" to deploy/${profile.name}.json (dashboard, the zone's Overview), or give the token Zone Read too`,
    };
  const rules = [];
  for (const phase of ZONE_PHASES) {
    const r = await cf(token, "GET", `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
    if (!r.ok) {
      if (r.errors?.[0]?.code === 10003) continue; // no rules in this phase yet
      return { error: `${phase}: ${JSON.stringify(r.errors)} (the token needs Zone WAF Read on ${profile.domain})` };
    }
    for (const x of r.result?.rules ?? [])
      rules.push({
        phase,
        description: x.description ?? "",
        action: x.action,
        enabled: x.enabled !== false,
        expression: x.expression,
        ...(x.ratelimit ? { ratelimit: x.ratelimit } : {}),
      });
  }
  return { rules };
}

/** What differs between the profile's zone_rules and the live ones, by description. */
async function zoneRulesDrift(profile, token) {
  const live = await liveZoneRules(profile, token);
  if (live.error) return { error: live.error, drift: [] };
  const want = profile.zone_rules ?? [];
  const key = (r) => `${r.phase}|${r.description}`;
  const have = new Map(live.rules.map((r) => [key(r), r]));
  const drift = [];
  for (const w of want) {
    const h = have.get(key(w));
    if (!h) {
      drift.push(`missing: ${w.phase} "${w.description}"`);
      continue;
    }
    for (const f of ["action", "enabled", "expression", "ratelimit"])
      if (JSON.stringify(h[f] ?? null) !== JSON.stringify(w[f] ?? null)) drift.push(`changed: "${w.description}" ${f}`);
    have.delete(key(w));
  }
  for (const h of have.values()) drift.push(`unexpected: ${h.phase} "${h.description}"`);
  return { drift, live: live.rules };
}

async function cmdZoneRules(name, opts) {
  const profile = loadProfile(name);
  const token = process.env.CLOUDFLARE_WAF_TOKEN;
  if (!token)
    die(
      `Set CLOUDFLARE_WAF_TOKEN to an API token with Zone > WAF > Read on ${profile.domain} (dash.cloudflare.com/profile/api-tokens). Read-only: this command never changes the zone.`,
    );
  if (opts.save) {
    const live = await liveZoneRules(profile, token);
    if (live.error) die(live.error);
    saveProfile({ ...profile, zone_rules: live.rules });
    log(`Saved ${live.rules.length} rule(s) to deploy/${name}.json as zone_rules. Back up the profile (it is git-ignored).`);
    for (const r of live.rules) log(`  ${r.phase}  ${r.action}  ${r.enabled ? "" : "(disabled) "}${r.description}`);
    return;
  }
  if (!profile.zone_rules) die(`deploy/${name}.json has no zone_rules yet. Record the live ones: pnpm afs zone-rules ${name} --save`);
  const z = await zoneRulesDrift(profile, token);
  if (z.error) die(z.error);
  for (const r of z.live) log(`  ${r.phase}  ${r.action}  ${r.enabled ? "" : "(disabled) "}${r.description}`);
  if (z.drift.length) {
    log(`\n✘ The zone's rules differ from deploy/${name}.json:`);
    for (const d of z.drift) log(`  ${d}`);
    log(`If the change was meant, record it: pnpm afs zone-rules ${name} --save`);
    process.exit(1);
  }
  log("\n✔ The zone's security rules match the profile.");
}

// ---------- main ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { pos, opts } = args(process.argv.slice(2));
  const [cmd, name, ...rest] = pos;
  const help = () =>
    log(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 18)
        .join("\n")
        .replace(/^\/\/ ?/gm, ""),
    );
  switch (cmd) {
    case "init":
      await cmdInit(name, opts);
      break;
    case "config":
      cmdConfig(name);
      break;
    case "deploy":
      cmdDeploy(name, rest, opts);
      break;
    case "email":
      await cmdEmail(name);
      break;
    case "check":
      await cmdCheck(name);
      break;
    case "suspend":
    case "unsuspend":
      await cmdSuspend(name, rest[0], opts, cmd === "suspend");
      break;
    case "pause":
    case "unpause":
      await cmdPause(name, rest[0], rest[1], opts, cmd === "pause");
      break;
    case "restore":
      await cmdRestore(name, rest[0]);
      break;
    case "email-test":
      await cmdEmailTest(name, rest[0]);
      break;
    case "digest":
      await cmdDigest(name);
      break;
    case "zone-rules":
      await cmdZoneRules(name, opts);
      break;
    default:
      help();
      process.exit(cmd ? 1 : 0);
  }
}
