import { Hono } from "hono";
import { OPT_OUT_COLUMN, type OptionalCategory, optionalCategory, validUnsubscribe } from "./email";
import type { SiteEnv } from "./env";
import { MARK, html, messagePage, page } from "./html";

/**
 * Turning off "updates" or "alerts" emails from the link in one (src/email.ts). The link is signed
 * for one person and category (c=alerts; none = updates), so it needs no sign-in. GET only shows a
 * button (mail scanners open links); POST turns them off. Mail apps' one-click unsubscribe
 * (RFC 8058) POSTs to the same URL.
 */
export const emailRoutes = new Hono<SiteEnv>();

const invalid = () =>
  messagePage({
    title: "Link not valid",
    message: "This unsubscribe link isn't valid. Turn emails off in your account instead.",
    status: 400,
    action: { href: "/dashboard/account#emails", label: "Email settings" },
  });

const COPY: Record<OptionalCategory, { title: string; what: string; done: string }> = {
  updates: {
    title: "Turn off updates",
    what: "stops getting emails about new things to set up in your projects",
    done: "You won't get emails about new setup items any more. Turn them back on in your account.",
  },
  alerts: {
    title: "Turn off alerts",
    what: "stops getting alerts when a site stops sending data or a project is close to a fair-use limit",
    done: "You won't get alerts about your projects any more. Turn them back on in your account.",
  },
};

async function linkOf(c: { env: SiteEnv["Bindings"]; req: { query(k: string): string | undefined } }) {
  const u = c.req.query("u") ?? "";
  const sig = c.req.query("s") ?? "";
  const category = optionalCategory(c.req.query("c"));
  if (!category || !(await validUnsubscribe(c.env, u, sig, category))) return null;
  return { u, sig, category };
}

emailRoutes.get("/email/unsubscribe", async (c) => {
  const link = await linkOf(c);
  if (!link) return invalid();
  const email = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(link.u).first<string>("email");
  if (!email) return invalid();
  const copy = COPY[link.category];
  const action = `/email/unsubscribe?u=${encodeURIComponent(link.u)}&s=${link.sig}${link.category === "updates" ? "" : `&c=${link.category}`}`;
  return page({
    title: copy.title,
    body: html`<section class="solo">
  <form class="tile solo-card" method="post" action="${action}">
    <span class="solo-mark">${MARK}</span>
    <h1>${copy.title}?</h1>
    <p class="lead">${email} ${copy.what}. Account and security emails (claims, members, connected apps, deletion) still go out.</p>
    <p class="row"><button class="btn btn-primary" type="submit">${copy.title}</button></p>
  </form>
</section>`,
  });
});

emailRoutes.post("/email/unsubscribe", async (c) => {
  const link = await linkOf(c);
  if (!link) return invalid();
  await c.env.DB.prepare(`UPDATE users SET ${OPT_OUT_COLUMN[link.category]} = 0 WHERE id = ?`).bind(link.u).run();
  const copy = COPY[link.category];
  return messagePage({
    title: link.category === "alerts" ? "Alerts turned off" : "Updates turned off",
    message: copy.done,
    action: { href: "/dashboard/account#emails", label: "Email settings" },
  });
});
