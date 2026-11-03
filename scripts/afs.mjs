#!/usr/bin/env node
// AgentFirstStack deployment tool. One deployment = one profile file, deploy/<profile>.json.
//
//   pnpm afs init <profile> --domain example.com --account <cloudflare-account-id> [--prefix afs]
//   pnpm afs config <profile>              write <app>/wrangler.deploy.json from the profile
//   pnpm afs deploy <profile> [app ...]    config + D1 migrations + wrangler deploy + secrets
//   pnpm afs email <profile>               Email Routing catch-all + Email Sending for the mail domain
//   pnpm afs check <profile>               end-to-end check of a live deployment (cleans up after itself)
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
const APPS = ["site", "analytics", "tags", "mail"];
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
    d1: { identity: `${p}-identity`, analytics: `${p}-analytics`, tags: `${p}-tags`, mail: `${p}-mail` },
    mailBlobs: `${p}-mail-blobs`,
    queues: { tags: `${p}-tags-dispatch`, mail: `${p}-mail-webhooks` },
  };
}

const hostOf = (profile, app) => (app === "site" ? profile.domain : `${app}.${profile.domain}`);

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

  cfg.d1_databases = (template.d1_databases ?? []).map((db) => {
    const key = app === "site" || db.binding === "AUTH_DB" ? "identity" : app;
    const id = profile.resources?.d1?.[key];
    if (!id) die(`deploy/${profile.name}.json has no resources.d1.${key}. Run \`pnpm afs init ${profile.name} ...\` to create it.`);
    return { ...db, database_name: n.d1[key], database_id: id };
  });
  if (template.r2_buckets) cfg.r2_buckets = template.r2_buckets.map((b) => ({ ...b, bucket_name: n.mailBlobs }));
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
  if (template.ratelimits && profile.ratelimit_namespace) {
    cfg.ratelimits = template.ratelimits.map((r) => ({ ...r, namespace_id: String(profile.ratelimit_namespace) }));
  }

  // AUTH_ISSUER: the OAuth authorization server (the site) that every app's RFC 9728 metadata names.
  const derived = { PUBLIC_BASE_URL: `https://${hostOf(profile, app)}`, AUTH_ISSUER: `https://${profile.domain}` };
  // tags links to analytics; the site's project pages redirect to analytics share pages.
  if (app === "tags" || app === "site") derived.ANALYTICS_BASE_URL = `https://${hostOf(profile, "analytics")}`;
  if (app === "mail") {
    derived.MAIL_DOMAIN = profile.mail_domain || profile.domain;
    derived.WORKER_NAME = n.worker("mail");
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
 * The secrets one app gets: ADMIN_TOKEN and INTERNAL_TOKEN (top level, every app), the site's
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (top level or under "site"), then the app's own block.
 */
export function secretsFor(secrets, app) {
  const out = {};
  for (const k of ["ADMIN_TOKEN", "INTERNAL_TOKEN"]) if (secrets[k]) out[k] = secrets[k];
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
  ensure("r2", ["r2", "bucket", "create", n.mailBlobs], n.mailBlobs);
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
      "Set CLOUDFLARE_API_TOKEN to a token with Zone Read, Zone Settings Edit, Email Routing Rules Edit and Email Sending Edit on the mail domain's zone.",
    );
  }
  const domain = profile.mail_domain || profile.domain;
  const worker = names(profile).worker("mail");
  const zone = await cf(token, "GET", `/zones?name=${encodeURIComponent(domain)}`);
  const zoneId = zone.result?.[0]?.id;
  if (!zoneId) die(`Zone ${domain} not found for this token. The mail domain must be a zone in your Cloudflare account (its apex).`);
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
    if (!created.ok) die(`Email Sending onboarding failed: ${JSON.stringify(created.errors)} (needs the Workers Paid plan).`);
    sub = created.result;
  }
  await cf(token, "POST", `/zones/${zoneId}/email/sending/subdomains/${sub.id}/dns`, {});
  const status = await cf(token, "GET", `/zones/${zoneId}/email/sending/subdomains/${sub.id}/dns/status`);
  log(
    `  Email Sending for ${domain}: ${status.result?.status ?? "unknown"}${status.result?.errors?.length ? ` ${JSON.stringify(status.result.errors)}` : ""}`,
  );
  log("\nReceiving works once MX has propagated; sending once the status above is ready.");
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
    ...["analytics", "tags", "mail"].map((a) => [`${a} manual`, `${base(a)}/llms.txt`]),
  ]) {
    const r = await call(url);
    step(label, r.status === 200, url);
  }
  const su = await call(`${base("site")}/v1/signup`, { method: "POST", body: JSON.stringify({ name: "afs-check" }) });
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
  const as = await call(`${base("site")}/.well-known/oauth-authorization-server`);
  step("OAuth authorization server metadata", as.json?.issuer === base("site"), as.json?.issuer ?? `HTTP ${as.status}`);
  for (const app of APPS) {
    const prm = await call(`${base(app)}/.well-known/oauth-protected-resource/mcp`);
    step(`${app}: protected resource metadata names it`, prm.json?.authorization_servers?.[0] === base("site"));
  }
  const claim = await call(`${base("site")}/v1/claim-link`, { method: "POST", headers: H });
  step("claim link", claim.status === 201 && String(claim.json?.url ?? "").startsWith(`${base("site")}/claim/`));
  for (const app of ["analytics", "tags", "mail"]) {
    const t = await call(`${base(app)}/mcp`, {
      method: "POST",
      headers: { ...H, accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const count = t.json?.result?.tools?.length ?? 0;
    step(`${app}: MCP tools/list`, count > 0, `${count} tools`);
  }
  // Clean up everything this check created.
  if (site.json?.site?.id) await call(`${base("analytics")}/v1/sites/${site.json.site.id}`, { method: "DELETE", headers: H });
  if (ctr.json?.container?.id) await call(`${base("tags")}/v1/containers/${ctr.json.container.id}`, { method: "DELETE", headers: H });
  if (inbox.json?.inbox?.id) await call(`${base("mail")}/v1/inboxes/${inbox.json.inbox.id}`, { method: "DELETE", headers: H });
  const me = await call(`${base("site")}/v1/me`, { headers: H });
  if (me.json?.key?.id) await call(`${base("site")}/v1/keys/${me.json.key.id}`, { method: "DELETE", headers: H });
  step("cleaned up and revoked the check key", true);
  return finish();

  function finish() {
    const failed = results.filter((x) => !x).length;
    log(failed ? `\n✘ ${failed} check(s) failed` : "\n✔ All checks passed");
    process.exit(failed ? 1 : 0);
  }
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
        .slice(1, 12)
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
    default:
      help();
      process.exit(cmd ? 1 : 0);
  }
}
