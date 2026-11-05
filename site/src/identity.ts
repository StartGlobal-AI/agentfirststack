import { ApiError, newId } from "@afs/shared";
import type { User } from "./env";

/**
 * People and their projects, in the identity DB. An account is shown to people as a "project";
 * a user reaches it only through a membership row, which every dashboard route checks.
 */

export type Role = "owner" | "member";

export interface Project {
  id: string;
  name: string | null;
  created_at: number;
  role: Role;
  joined_at: number;
}

/** Most projects one person may belong to (claims, imports and new projects all count). */
export const MAX_PROJECTS_PER_USER = 100;

/**
 * Most live connected apps (OAuth grants) one person may hold: not revoked, and used (or created)
 * in the last 30 days, the lifetime of a refresh token. Each grant can mint access tokens.
 */
export const MAX_GRANTS_PER_USER = 50;

export async function upsertUser(
  db: D1Database,
  p: { sub: string; email: string; name?: string | null; picture?: string | null },
): Promise<User> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture,
         last_login_at = excluded.last_login_at
       RETURNING id, email, name, picture, created_at`,
    )
    .bind(newId("usr"), p.sub, p.email, p.name ?? null, p.picture ?? null, now, now)
    .first<User>();
  if (!row) throw new Error("user upsert returned nothing");
  return row;
}

export async function listProjects(db: D1Database, userId: string): Promise<Project[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.created_at, m.role, m.created_at AS joined_at
         FROM memberships m JOIN accounts a ON a.id = m.account_id
        WHERE m.user_id = ? AND a.deleted_at IS NULL ORDER BY m.created_at`,
    )
    .bind(userId)
    .all<Project>();
  return results;
}

export interface DeletedProject {
  id: string;
  name: string | null;
  deleted_at: number;
  purge_after: number;
}

/** Projects this person owns that were deleted and can still be restored. */
export async function listDeletedProjects(db: D1Database, userId: string, now = Date.now()): Promise<DeletedProject[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.deleted_at, a.purge_after
         FROM memberships m JOIN accounts a ON a.id = m.account_id
        WHERE m.user_id = ? AND m.role = 'owner' AND a.deleted_at IS NOT NULL AND a.purged_at IS NULL AND a.purge_after > ?
        ORDER BY a.deleted_at DESC`,
    )
    .bind(userId, now)
    .all<DeletedProject>();
  return results;
}

/** The user's membership of a project, or null (callers turn that into a 404). A deleted project is null too. */
export async function getProject(db: D1Database, userId: string, accountId: string): Promise<Project | null> {
  return db
    .prepare(
      `SELECT a.id, a.name, a.created_at, m.role, m.created_at AS joined_at
         FROM memberships m JOIN accounts a ON a.id = m.account_id
        WHERE m.user_id = ? AND m.account_id = ? AND a.deleted_at IS NULL`,
    )
    .bind(userId, accountId)
    .first<Project>();
}

export const projectNotFound = () =>
  new ApiError(
    404,
    "not_found",
    "Project not found.",
    "It doesn't exist, or you aren't a member. Your projects are listed on the dashboard.",
  );

export async function requireProject(db: D1Database, userId: string, accountId: string): Promise<Project> {
  const p = await getProject(db, userId, accountId);
  if (!p) throw projectNotFound();
  return p;
}

async function assertRoomForProject(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT count(*) AS n FROM memberships WHERE user_id = ?").bind(userId).first<{ n: number }>();
  if ((row?.n ?? 0) >= MAX_PROJECTS_PER_USER) {
    throw new ApiError(
      409,
      "too_many_projects",
      `You already belong to ${MAX_PROJECTS_PER_USER} projects.`,
      "Leave a project you no longer need, then try again.",
    );
  }
}

/**
 * Add a user to a project: owner when it has none yet, otherwise member. Someone who is already
 * a member of an ownerless project becomes its owner.
 */
export async function addMember(db: D1Database, userId: string, accountId: string): Promise<{ role: Role; existing: boolean }> {
  const owner = await db
    .prepare("SELECT user_id FROM memberships WHERE account_id = ? AND role = 'owner' LIMIT 1")
    .bind(accountId)
    .first<{ user_id: string }>();
  const mine = await db
    .prepare("SELECT role FROM memberships WHERE account_id = ? AND user_id = ?")
    .bind(accountId, userId)
    .first<{ role: Role }>();
  if (mine) {
    if (mine.role === "member" && !owner) {
      await db.prepare("UPDATE memberships SET role = 'owner' WHERE account_id = ? AND user_id = ?").bind(accountId, userId).run();
      return { role: "owner", existing: true };
    }
    return { role: mine.role, existing: true };
  }
  await assertRoomForProject(db, userId);
  const role: Role = owner ? "member" : "owner";
  await db
    .prepare("INSERT OR IGNORE INTO memberships (user_id, account_id, role, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, accountId, role, Date.now())
    .run();
  return { role, existing: false };
}

/** A new, empty project owned by the user (no API key: the person makes one when they need it). */
export async function createProject(db: D1Database, userId: string, name: string | null): Promise<string> {
  await assertRoomForProject(db, userId);
  const id = newId("acct");
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)").bind(id, name, now),
    db.prepare("INSERT INTO memberships (user_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(userId, id, now),
  ]);
  return id;
}

export interface Member {
  user_id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: number;
}

export async function listMembers(db: D1Database, accountId: string): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT m.user_id, u.email, u.name, m.role, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.account_id = ? ORDER BY m.role = 'owner' DESC, m.created_at`,
    )
    .bind(accountId)
    .all<Member>();
  return results;
}

/** Statements that end a grant: no refresh, no codes, its access tokens revoked. */
function revokeGrantStatements(db: D1Database, where: string, binds: unknown[], now: number) {
  return [
    db
      .prepare(
        `UPDATE api_keys SET revoked_at = ? WHERE revoked_at IS NULL AND oauth_grant_id IN (SELECT id FROM oauth_grants WHERE ${where})`,
      )
      .bind(now, ...binds),
    db.prepare(`DELETE FROM oauth_refresh_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE ${where})`).bind(...binds),
    db.prepare(`DELETE FROM oauth_codes WHERE grant_id IN (SELECT id FROM oauth_grants WHERE ${where})`).bind(...binds),
    db.prepare(`UPDATE oauth_grants SET revoked_at = ? WHERE revoked_at IS NULL AND ${where}`).bind(now, ...binds),
  ];
}

export async function revokeGrant(db: D1Database, grantId: string): Promise<void> {
  await db.batch(revokeGrantStatements(db, "id = ?", [grantId], Date.now()));
}

/**
 * Remove someone from a project (or let them leave). Everything that gave them access goes at
 * once: the apps they connected to it, the API keys they created in the dashboard (they saw each
 * key once and may still hold it), and the invite links they made that nobody has used yet.
 */
export async function removeMember(db: D1Database, accountId: string, userId: string): Promise<void> {
  const now = Date.now();
  await db.batch([
    ...revokeGrantStatements(db, "account_id = ? AND user_id = ?", [accountId, userId], now),
    db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE account_id = ? AND created_by_user_id = ? AND revoked_at IS NULL")
      .bind(now, accountId, userId),
    db.prepare("DELETE FROM claim_links WHERE account_id = ? AND created_by_user_id = ? AND used_at IS NULL").bind(accountId, userId),
    db.prepare("DELETE FROM memberships WHERE account_id = ? AND user_id = ?").bind(accountId, userId),
  ]);
}

/** Refuse a new OAuth grant when the person already holds MAX_GRANTS_PER_USER live ones. */
export async function assertRoomForGrant(db: D1Database, userId: string, now = Date.now()): Promise<void> {
  const n = await db
    .prepare("SELECT count(*) AS n FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL AND COALESCE(last_used_at, created_at) > ?")
    .bind(userId, now - 30 * 86_400_000)
    .first<number>("n");
  if ((n ?? 0) >= MAX_GRANTS_PER_USER) {
    throw new ApiError(
      409,
      "too_many_apps",
      `You already have ${MAX_GRANTS_PER_USER} connected apps.`,
      "Disconnect apps you no longer use under Connected apps in the dashboard, then connect again.",
    );
  }
}

/**
 * Delete a person: their user row, memberships, sessions, OAuth grants with their refresh tokens
 * and codes, and every access token those grants issued. As when they leave a project, the API
 * keys they created in the dashboard are revoked and their unused invite links deleted (otherwise
 * deleting your account would be a way around being removed). Projects and their agent keys stay
 * (they belong to the project); a project with no members left is simply unclaimed again.
 */
export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM api_keys WHERE oauth_grant_id IN (SELECT id FROM oauth_grants WHERE user_id = ?)").bind(userId),
    db.prepare("UPDATE api_keys SET revoked_at = ? WHERE created_by_user_id = ? AND revoked_at IS NULL").bind(Date.now(), userId),
    db.prepare("DELETE FROM claim_links WHERE created_by_user_id = ? AND used_at IS NULL").bind(userId),
    db.prepare("UPDATE api_keys SET created_by_user_id = NULL WHERE created_by_user_id = ?").bind(userId),
    db.prepare("UPDATE claim_links SET created_by_user_id = NULL WHERE created_by_user_id = ?").bind(userId),
    db.prepare("UPDATE claim_links SET used_by_user_id = NULL WHERE used_by_user_id = ?").bind(userId),
    // The emails we sent them (with their address and content).
    db.prepare("DELETE FROM email_outbox WHERE user_id = ?").bind(userId),
    // Cascades: memberships, sessions, oauth_grants -> oauth_codes, oauth_refresh_tokens.
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}
