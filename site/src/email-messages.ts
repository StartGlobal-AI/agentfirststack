import { type OutgoingEmail, type QueueResult, queueEmail } from "./email";
import type { Bindings } from "./env";
import { cleanupPrompt } from "./project-deletion";
import { itemsAfter } from "./setup-catalog";

/**
 * What the platform emails people, and when (sent through email.ts). Account emails always go out:
 *
 *   project_claimed     you claimed a project: you own it now               to you
 *   member_joined       someone joined through an invite link               to the owner
 *   member_removed      the owner removed you                               to you
 *   app_connected       you connected a chat app (OAuth) to a project       to you
 *   project_deleted     the owner deleted it: restore until <date>          to the owner and members
 *   project_restored    the owner restored it                               to members
 *   purge_soon          it is erased tomorrow                               to the owner
 *   project_purged      it was erased                                       to the owner
 *   project_suspended / project_unsuspended   the operator stopped / resumed it   to the owner
 *   account_deleted     you deleted your account                            to you
 *
 * Updates (off with one click, or in Account):
 *
 *   setup_notice        new setup items for a project its agent hasn't applied   to the owner
 */

type WaitUntil = ((p: Promise<unknown>) => void) | undefined;

interface Person {
  userId: string;
  email: string;
  role: "owner" | "member";
}

/** The project's people (at most 50). */
export async function projectPeople(db: D1Database, accountId: string): Promise<Person[]> {
  const { results } = await db
    .prepare(
      "SELECT u.id AS userId, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.account_id = ? ORDER BY m.created_at LIMIT 50",
    )
    .bind(accountId)
    .all<Person>();
  return results;
}

async function personById(db: D1Database, userId: string): Promise<{ userId: string; email: string } | null> {
  return db.prepare("SELECT id AS userId, email FROM users WHERE id = ?").bind(userId).first<{ userId: string; email: string }>();
}

const nameOf = (name: string | null | undefined) => name || "Untitled project";
const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const projectUrl = (base: string, id: string) => `${base}/dashboard/projects/${id}`;

async function send(env: Bindings, base: string, wu: WaitUntil, e: OutgoingEmail, later = false): Promise<QueueResult> {
  try {
    return await queueEmail(env, base, e, { waitUntil: wu, later });
  } catch (err) {
    // An email never breaks the action that caused it.
    console.error(JSON.stringify({ event: "email.queue_failed", kind: e.kind, error: String((err as Error)?.message ?? err) }));
    return "failed";
  }
}

// ---------- claims and members ----------

/** After a claim link was used: the new owner hears they own it; an owner hears someone joined. */
export async function emailClaimed(
  env: Bindings,
  base: string,
  wu: WaitUntil,
  p: { accountId: string; name: string | null; userId: string; role: "owner" | "member"; at: number },
) {
  const name = nameOf(p.name);
  const who = await personById(env.DB, p.userId);
  if (!who) return;
  if (p.role === "owner") {
    await send(env, base, wu, {
      kind: "project_claimed",
      category: "account",
      dedupeKey: `project_claimed:${p.accountId}:${p.userId}`,
      to: who,
      accountId: p.accountId,
      content: {
        subject: `You now own ${name} on AgentFirstStack`,
        body: [
          `You claimed ${name}. Its analytics, tags, session replay and mail are in your dashboard, and the agent that set it up keeps working with its own key.`,
          "From the dashboard you can invite teammates, manage API keys, and connect chat apps like Claude or ChatGPT to the project.",
        ],
        action: { label: "Open the project", url: projectUrl(base, p.accountId) },
        ask: `Give me an update on our AgentFirstStack project ${name}: this week's visitors and goals, failing tags or conversions, frustrated sessions, new emails, and anything the setup check says to fix.`,
      },
    });
    return;
  }
  for (const owner of (await projectPeople(env.DB, p.accountId)).filter((x) => x.role === "owner"))
    await send(env, base, wu, {
      kind: "member_joined",
      category: "account",
      dedupeKey: `member_joined:${p.accountId}:${p.userId}:${p.at}:${owner.userId}`,
      to: owner,
      accountId: p.accountId,
      content: {
        subject: `${who.email} joined ${name}`,
        body: [
          `${who.email} used an invite link to join ${name}. They can now see its analytics, tags, session replay and mail.`,
          "If you didn't expect this, remove them from the project's members.",
        ],
        action: { label: "See members", url: `${projectUrl(base, p.accountId)}/members` },
      },
    });
}

/** The owner removed someone (not someone leaving on their own). */
export async function emailMemberRemoved(
  env: Bindings,
  base: string,
  wu: WaitUntil,
  p: { accountId: string; name: string | null; userId: string; at: number },
) {
  const who = await personById(env.DB, p.userId);
  if (!who) return;
  const name = nameOf(p.name);
  await send(env, base, wu, {
    kind: "member_removed",
    category: "account",
    dedupeKey: `member_removed:${p.accountId}:${p.userId}:${p.at}`,
    to: who,
    accountId: p.accountId,
    content: {
      subject: `You no longer have access to ${name}`,
      body: [
        `The owner of ${name} removed you from the project on AgentFirstStack. It's no longer in your projects, and the API keys you created for it stopped working.`,
      ],
      action: { label: "Your projects", url: `${base}/dashboard` },
    },
  });
}

/** A person connected a chat app (OAuth grant) to a project. */
export async function emailAppConnected(
  env: Bindings,
  base: string,
  wu: WaitUntil,
  p: { grantId: string; accountId: string; name: string | null; userId: string; client: string; redirectHost: string; scope: string },
) {
  const who = await personById(env.DB, p.userId);
  if (!who) return;
  const name = nameOf(p.name);
  const read = p.scope === "read";
  await send(env, base, wu, {
    kind: "app_connected",
    category: "account",
    dedupeKey: `app_connected:${p.grantId}`,
    to: who,
    accountId: p.accountId,
    content: {
      subject: `${p.client} can now use ${name}`,
      body: [
        `You connected an app calling itself "${p.client}" to ${name}${read ? ", with read-only access" : ""}. It can ${
          read ? "read" : "read and change"
        } the project's analytics, tags, session replay and mail until you disconnect it.`,
        `It signs in through ${p.redirectHost}. If this wasn't you, disconnect it now.`,
      ],
      action: { label: "See connected apps", url: `${base}/dashboard/apps` },
    },
  });
}

// ---------- deletion ----------

/** The owner deleted the project: they get the restore date and the cleanup; members are told. */
export async function emailProjectDeleted(
  env: Bindings,
  base: string,
  wu: WaitUntil,
  p: { accountId: string; name: string | null; byUserId: string; deletedAt: number; purgeAfter: number },
) {
  const name = nameOf(p.name);
  for (const person of await projectPeople(env.DB, p.accountId)) {
    const actor = person.userId === p.byUserId;
    await send(env, base, wu, {
      kind: "project_deleted",
      category: "account",
      dedupeKey: `project_deleted:${p.accountId}:${p.deletedAt}:${person.userId}`,
      to: person,
      accountId: p.accountId,
      content: actor
        ? {
            subject: `${name} is deleted`,
            body: [
              `You deleted ${name} on ${day(p.deletedAt)}. Its keys, tracking, session recording and inbound mail stopped at once.`,
              `You can restore it until ${day(p.purgeAfter)}, from Deleted projects on your projects page. After that its analytics, tags, recordings and mail are erased for good.`,
            ],
            action: { label: "Restore it", url: `${base}/dashboard` },
            ask: cleanupPrompt(name),
            after: ["Its inbox addresses that received mail stay reserved for good, so nobody else can receive this project's email."],
          }
        : {
            subject: `${name} was deleted`,
            body: [
              `The owner of ${name} deleted it on ${day(p.deletedAt)}. It's no longer in your projects. If it's restored before ${day(p.purgeAfter)}, we'll let you know.`,
            ],
          },
    });
  }
}

/** The owner restored it: the members who were told it was deleted hear it's back. */
export async function emailProjectRestored(
  env: Bindings,
  base: string,
  wu: WaitUntil,
  p: { accountId: string; name: string | null; byUserId: string | null; deletedAt: number },
) {
  const name = nameOf(p.name);
  for (const person of (await projectPeople(env.DB, p.accountId)).filter((x) => x.userId !== p.byUserId))
    await send(env, base, wu, {
      kind: "project_restored",
      category: "account",
      dedupeKey: `project_restored:${p.accountId}:${p.deletedAt}:${person.userId}`,
      to: person,
      accountId: p.accountId,
      content: {
        subject: `${name} is back`,
        body: [`${name} was restored. It's in your projects again, and its keys, tracking and mail work as before.`],
        action: { label: "Open the project", url: projectUrl(base, p.accountId) },
      },
    });
}

/** Hourly cron: owners of projects erased within the next day get one reminder. */
export async function emailPurgeReminders(env: Bindings, base: string, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, deleted_at, purge_after FROM accounts
      WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after > ? AND purge_after <= ? LIMIT 200`,
  )
    .bind(now, now + 86_400_000)
    .all<{ id: string; name: string | null; deleted_at: number; purge_after: number }>();
  let queued = 0;
  for (const a of results) {
    const name = nameOf(a.name);
    for (const owner of (await projectPeople(env.DB, a.id)).filter((x) => x.role === "owner")) {
      const r = await send(
        env,
        base,
        undefined,
        {
          kind: "purge_soon",
          category: "account",
          dedupeKey: `purge_soon:${a.id}:${a.purge_after}:${owner.userId}`,
          to: owner,
          accountId: a.id,
          content: {
            subject: `${name} will be erased tomorrow`,
            body: [
              `You deleted ${name} on ${day(a.deleted_at)}. On ${day(a.purge_after)} its analytics, tags, recordings and mail are erased for good.`,
              "To keep it, restore it before then.",
            ],
            action: { label: "Restore it", url: `${base}/dashboard` },
          },
        },
        true,
      );
      if (r === "queued") queued++;
    }
  }
  return queued;
}

/** The purge erased a project: its owners (read before the memberships go) hear it's done. */
export async function emailProjectPurged(env: Bindings, base: string, p: { accountId: string; name: string | null; owners: Person[] }) {
  const name = nameOf(p.name);
  for (const owner of p.owners)
    await send(
      env,
      base,
      undefined,
      {
        kind: "project_purged",
        category: "account",
        dedupeKey: `project_purged:${p.accountId}:${owner.userId}`,
        to: owner,
        accountId: p.accountId,
        content: {
          subject: `${name} is erased`,
          body: [
            `${name}'s analytics, tags, recordings and mail are erased, along with its keys and members. This can't be undone.`,
            "Its inbox addresses that received mail stay reserved, so nobody else can receive its email.",
          ],
          action: { label: "Your projects", url: `${base}/dashboard` },
        },
      },
      true,
    );
}

// ---------- operator ----------

export async function emailSuspension(
  env: Bindings,
  base: string,
  wu: WaitUntil,
  p: { accountId: string; name: string | null; suspended: boolean; at: number },
) {
  const name = nameOf(p.name);
  for (const owner of (await projectPeople(env.DB, p.accountId)).filter((x) => x.role === "owner"))
    await send(env, base, wu, {
      kind: p.suspended ? "project_suspended" : "project_unsuspended",
      category: "account",
      dedupeKey: `${p.suspended ? "project_suspended" : "project_unsuspended"}:${p.accountId}:${p.at}:${owner.userId}`,
      to: owner,
      accountId: p.accountId,
      content: p.suspended
        ? {
            subject: `${name} is suspended`,
            body: [
              `We suspended ${name} for abuse of the free AgentFirstStack service. Its keys, tracking, session recording and inbound mail have stopped. Its data is kept.`,
              `If you think this is a mistake, email abuse@agentfirststack.com with the project id ${p.accountId}.`,
            ],
          }
        : {
            subject: `${name} works again`,
            body: [`${name} is no longer suspended. Its keys, tracking, recording and mail work again.`],
            action: { label: "Open the project", url: projectUrl(base, p.accountId) },
          },
    });
}

// ---------- the person's own account ----------

/** Sent before the user row goes (to the address alone, so deleting the user doesn't drop it). */
export async function emailAccountDeleted(env: Bindings, base: string, p: { userId: string; email: string }) {
  await send(env, base, undefined, {
    kind: "account_deleted",
    category: "account",
    dedupeKey: `account_deleted:${p.userId}`,
    to: { userId: null, email: p.email },
    content: {
      subject: "Your AgentFirstStack account is deleted",
      body: [
        "Your sign-in, project memberships, sessions and connected apps are gone.",
        "Projects you belonged to keep working for their agents. A project you were the only member of is unclaimed again; its agent can send a new claim link.",
      ],
    },
  });
}

// ---------- updates ----------

/**
 * Daily cron (after the notices are written): owners of claimed projects whose agent ran the setup
 * check before, and hasn't seen the newest setup items, hear what's new, once per catalog version.
 */
export async function emailSetupNotices(env: Bindings, base: string, rows: { account_id: string; seen: number | null }[], version: number) {
  let queued = 0;
  for (const r of rows) {
    if (r.seen === null) continue; // never checked: the agent's own notice covers it
    const fresh = itemsAfter(r.seen).map((i) => i.label);
    if (!fresh.length) continue;
    const owners = (await projectPeople(env.DB, r.account_id)).filter((x) => x.role === "owner");
    if (!owners.length) continue;
    const project = await env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(r.account_id).first<string | null>("name");
    const name = nameOf(project);
    for (const owner of owners) {
      const res = await send(
        env,
        base,
        undefined,
        {
          kind: "setup_notice",
          category: "updates",
          dedupeKey: `setup_notice:${r.account_id}:${version}:${owner.userId}`,
          to: owner,
          accountId: r.account_id,
          content: {
            subject: `New in AgentFirstStack for ${name}`,
            body: [
              `Since your agent last checked ${name}'s setup, AgentFirstStack added: ${fresh.join("; ")}.`,
              "Your agent sets them up when it runs the setup check. Paste this into it:",
            ],
            ask: `Run the AgentFirstStack setup check for our project ${name} (GET ${base}/v1/setup, or the afs_check_setup MCP tool) and apply what it lists, then show me what changed.`,
            action: { label: "Open the project", url: projectUrl(base, r.account_id) },
          },
        },
        true,
      );
      if (res === "queued") queued++;
    }
  }
  return queued;
}
