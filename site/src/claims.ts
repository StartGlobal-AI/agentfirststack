import { type AuthContext, ApiError, assertWrite, randomString, requireAuth, sha256Hex } from "@afs/shared";
import { Hono } from "hono";
import { DAY, type SiteEnv } from "./env";
import { siteBase } from "./google";
import { csrfField, fmtDate, html, htmlErrorHandler, messagePage, page } from "./html";
import { addMember, getProject } from "./identity";
import { projectResources } from "./services";
import { optionalSession, readForm, redirect, signinUrl } from "./session";
import { resourcesView } from "./views";

/**
 * Claim links: how the person behind an agent gets into the project it created. Anyone holding a
 * full-access key already controls the project, so a key holder may mint one. The token is
 * random, single use and lasts 7 days; only its SHA-256 is stored.
 */

export const CLAIM_TTL = 7 * DAY;
const MAX_ACTIVE_LINKS = 25;
const TOKEN = /^[0-9a-z]{40}$/;

export interface ClaimLink {
  url: string;
  expires_at: number;
}

export async function createClaimLink(
  db: D1Database,
  base: string,
  accountId: string,
  by: { keyId?: string; userId?: string },
): Promise<ClaimLink> {
  const now = Date.now();
  const active = await db
    .prepare("SELECT count(*) AS n FROM claim_links WHERE account_id = ? AND used_at IS NULL AND expires_at > ?")
    .bind(accountId, now)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_LINKS) {
    throw new ApiError(
      429,
      "too_many_claim_links",
      `This project already has ${MAX_ACTIVE_LINKS} unused claim links.`,
      "Give the owner one you already created (each lasts 7 days), or wait for some to expire.",
    );
  }
  const token = randomString(40);
  const expiresAt = now + CLAIM_TTL;
  await db
    .prepare(
      "INSERT INTO claim_links (hash, account_id, created_by_key_id, created_by_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(await sha256Hex(token), accountId, by.keyId ?? null, by.userId ?? null, now, expiresAt)
    .run();
  return { url: `${base}/claim/${token}`, expires_at: expiresAt };
}

/** The response body of POST /v1/claim-link and the afs_create_claim_link MCP tool. */
export function claimLinkResponse(link: ClaimLink, accountId: string) {
  return {
    url: link.url,
    expires_at: link.expires_at,
    account_id: accountId,
    note: "Give this URL to the person who owns this project. It works once and expires in 7 days. They sign in with Google and see everything this key created in a dashboard.",
    next_steps: [
      `Send the owner this link: ${link.url}`,
      "Nothing changes for your key: agent keys keep working after the project is claimed.",
    ],
  };
}

/** POST /v1/claim-link, mounted with requireAuth(). Full-access keys only. */
export const claimLinkApi = new Hono<SiteEnv>();
claimLinkApi.post("/v1/claim-link", requireAuth<SiteEnv>(), async (c) => {
  const auth: AuthContext = c.var.auth;
  assertWrite(auth);
  const link = await createClaimLink(c.env.DB, siteBase(c), auth.accountId, { keyId: auth.keyId });
  return c.json(claimLinkResponse(link, auth.accountId), 201);
});

interface ClaimRow {
  hash: string;
  account_id: string;
  expires_at: number;
  used_at: number | null;
  name: string | null;
  account_created_at: number;
}

async function findClaim(db: D1Database, token: string): Promise<ClaimRow | null> {
  if (!TOKEN.test(token)) return null;
  return db
    .prepare(
      `SELECT l.hash, l.account_id, l.expires_at, l.used_at, a.name, a.created_at AS account_created_at
         FROM claim_links l JOIN accounts a ON a.id = l.account_id WHERE l.hash = ?`,
    )
    .bind(await sha256Hex(token))
    .first<ClaimRow>();
}

const invalidLink = (session: SiteEnv["Variables"]["session"] | undefined) =>
  messagePage({
    title: "This claim link doesn't work",
    message:
      "It was already used, has expired (links last 7 days), or was copied incompletely. Ask your agent for a new one: POST /v1/claim-link, or the afs_create_claim_link MCP tool.",
    status: 404,
    session,
    action: session ? { href: "/dashboard", label: "Go to your projects" } : undefined,
  });

export const claimRoutes = new Hono<SiteEnv>();
claimRoutes.onError(htmlErrorHandler);

claimRoutes.get("/claim/:token", optionalSession, async (c) => {
  const token = c.req.param("token");
  const session = c.var.session;
  const claim = await findClaim(c.env.DB, token);
  if (!claim || claim.used_at || claim.expires_at <= Date.now()) return invalidLink(session);
  if (!session) {
    return page({
      title: "Claim a project",
      body: html`<section class="narrow">
  <h1>Claim a project</h1>
  <p class="lead">An agent set up a project on AgentFirstStack and sent you this link so you can see and manage it. Sign in to continue.</p>
  <p class="actions"><a class="btn btn-primary" href="${signinUrl(`/claim/${token}`)}">Sign in to claim</a></p>
  <p class="muted small">The link works once and expires ${fmtDate(claim.expires_at)}.</p>
</section>`,
    });
  }
  const mine = await getProject(c.env.DB, session.user.id, claim.account_id);
  const owner = await c.env.DB.prepare("SELECT 1 AS x FROM memberships WHERE account_id = ? AND role = 'owner' LIMIT 1")
    .bind(claim.account_id)
    .first();
  const resources = await projectResources(c.env, claim.account_id);
  const name = claim.name || "Untitled project";
  return page({
    title: "Claim a project",
    session,
    body: html`<section class="narrow">
  <h1>Claim “${name}”</h1>
  <p class="lead">${
    mine
      ? mine.role === "owner" || owner
        ? "You already have access to this project."
        : "You're a member of this project, which has no owner. Claim it to become the owner."
      : owner
        ? "This project already has an owner. Claiming adds you as a member."
        : "Claiming makes you the owner of this project. Agent keys keep working."
  }</p>
  <dl class="facts">
    <div><dt>Project</dt><dd><code>${claim.account_id}</code></dd></div>
    <div><dt>Created</dt><dd>${fmtDate(claim.account_created_at)}</dd></div>
    <div><dt>Signed in as</dt><dd>${session.user.email}</dd></div>
  </dl>
  ${resourcesView(resources)}
  ${
    mine && (mine.role === "owner" || owner)
      ? html`<p class="actions"><a class="btn btn-primary" href="/dashboard/projects/${claim.account_id}">Open the project</a></p>`
      : html`<form method="post" action="/claim/${token}" class="actions">${csrfField(session)}<button class="btn btn-primary" type="submit">Claim project</button><a class="btn btn-quiet" href="/dashboard">Not now</a></form>`
  }
</section>`,
  });
});

claimRoutes.post("/claim/:token", optionalSession, async (c) => {
  const token = c.req.param("token");
  if (!c.var.session) return redirect(signinUrl(`/claim/${token}`));
  await readForm(c);
  const session = c.var.session;
  const claim = await findClaim(c.env.DB, token);
  if (!claim) return invalidLink(session);
  // Single use: only the request that flips used_at gets in.
  const now = Date.now();
  const res = await c.env.DB.prepare(
    "UPDATE claim_links SET used_at = ?, used_by_user_id = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(now, session.user.id, claim.hash, now)
    .run();
  if (!res.meta.changes) return invalidLink(session);
  try {
    await addMember(c.env.DB, session.user.id, claim.account_id);
  } catch (e) {
    // Not added (e.g. too many projects): give the link back so it can be used once fixed.
    await c.env.DB.prepare("UPDATE claim_links SET used_at = NULL, used_by_user_id = NULL WHERE hash = ?").bind(claim.hash).run();
    throw e;
  }
  return redirect(`/dashboard/projects/${claim.account_id}`);
});
