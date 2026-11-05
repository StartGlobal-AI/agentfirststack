import { Hono } from "hono";
import { validUnsubscribe } from "./email";
import type { SiteEnv } from "./env";
import { MARK, html, messagePage, page } from "./html";

/**
 * Turning off "updates" emails from the link in one (src/email.ts). The link is signed for one
 * person, so it needs no sign-in. GET only shows a button (mail scanners open links); POST turns
 * the updates off. Mail apps' one-click unsubscribe (RFC 8058) POSTs to the same URL.
 */
export const emailRoutes = new Hono<SiteEnv>();

const invalid = () =>
  messagePage({
    title: "Link not valid",
    message: "This unsubscribe link isn't valid. Turn emails off in your account instead.",
    status: 400,
    action: { href: "/dashboard/account#emails", label: "Email settings" },
  });

emailRoutes.get("/email/unsubscribe", async (c) => {
  const u = c.req.query("u") ?? "";
  const sig = c.req.query("s") ?? "";
  if (!(await validUnsubscribe(c.env, u, sig))) return invalid();
  const email = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(u).first<string>("email");
  if (!email) return invalid();
  return page({
    title: "Turn off updates",
    body: html`<section class="solo">
  <form class="tile solo-card" method="post" action="/email/unsubscribe?u=${encodeURIComponent(u)}&amp;s=${sig}">
    <span class="solo-mark">${MARK}</span>
    <h1>Turn off updates?</h1>
    <p class="lead">${email} stops getting emails about new things to set up in your projects. Account and security emails (claims, members, connected apps, deletion) still go out.</p>
    <p class="row"><button class="btn btn-primary" type="submit">Turn off updates</button></p>
  </form>
</section>`,
  });
});

emailRoutes.post("/email/unsubscribe", async (c) => {
  const u = c.req.query("u") ?? "";
  const sig = c.req.query("s") ?? "";
  if (!(await validUnsubscribe(c.env, u, sig))) return invalid();
  await c.env.DB.prepare("UPDATE users SET email_updates = 0 WHERE id = ?").bind(u).run();
  return messagePage({
    title: "Updates turned off",
    message: "You won't get emails about new setup items any more. Turn them back on in your account.",
    action: { href: "/dashboard/account#emails", label: "Email settings" },
  });
});
