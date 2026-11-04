import { describe, expect, it } from "vitest";
import { meta, page, snapshot } from "../fixtures/rrweb";
import { call, hosted, newSid, newSite, postF, sendChunk, tool } from "./helpers";

let rseq = 0;
const rid = () => `r${String(rseq++).padStart(15, "0")}`;

describe("5. surveys", () => {
  it("unverified sites keep drafts only; create is idempotent by name; templates expand", async () => {
    const { key, site } = await newSite("shop.test", {}, undefined, { verified: false });
    const c = await call("POST", `/v1/sites/${site}/surveys`, { key, body: { name: "NPS", kind: "popover", template: "nps" } });
    expect(c.status).toBe(201);
    expect(c.json.survey).toMatchObject({
      status: "draft",
      kind: "popover",
      version: 1,
      question_ids: ["q1", "q2"],
      // the texts come back as untrusted: whoever configured the survey wrote them
      untrusted: { name: "NPS", questions: [{ id: "q1", type: "nps" }, { id: "q2" }] },
    });
    expect(c.json.survey.questions).toBeUndefined();
    expect(c.json.preview_url).toBeUndefined();
    expect(c.json.next_steps[0]).toContain("Verify the domain");
    const again = await call("POST", `/v1/sites/${site}/surveys`, { key, body: { name: "NPS", kind: "feedback" } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, survey: { id: c.json.survey.id, kind: "popover" } });
    const active = await call("PATCH", `/v1/sites/${site}/surveys/${c.json.survey.id}`, { key, body: { status: "active" } });
    expect(active.status).toBe(403);
    expect(active.json.error.code).toBe("domain_not_verified");
    expect((await call("POST", `/v1/sites/${site}/surveys/${c.json.survey.id}/test`, { key })).json.error.code).toBe("domain_not_verified");
    expect((await call("GET", `/r/${site}.js`)).text).not.toContain('"sv"');
    const bad = await call("POST", `/v1/sites/${site}/surveys`, {
      key,
      body: { name: "Bad", kind: "popover", questions: [{ type: "nps", text: "a", logic: [{ goto: "q1" }] }] },
    });
    expect(bad.json.error.hint).toContain("later question");
    expect((await call("POST", `/v1/sites/${site}/surveys`, { key, body: { name: "E", kind: "embedded" } })).json.error.hint).toContain(
      "selector",
    );
    const reserved = await call("POST", `/v1/sites/${site}/surveys`, {
      key,
      body: { name: "R", kind: "popover", questions: [{ id: "constructor", type: "nps", text: "a" }] },
    });
    expect(reserved.status).toBe(400);
  });

  it("end to end: active -> loader -> widget script -> impression and answers -> responses, CSV, results, sessions, transcript", async () => {
    const { key, site } = await newSite("shop.test");
    const c = await call("POST", `/v1/sites/${site}/surveys`, {
      key,
      body: { name: "Checkout NPS", kind: "popover", template: "nps", status: "active", targeting: { pages: ["/checkout*"] } },
    });
    expect(c.status).toBe(201);
    const id = c.json.survey.id as string;
    expect(c.json.preview_url).toBeUndefined();
    const pre = (await call("POST", `/v1/sites/${site}/surveys/${id}/test`, { key })).json.preview_url as string;
    expect(pre).toMatch(new RegExp(`^https://shop\\.test/checkout\\?afsr_survey=${id}\\.[0-9a-z]{24}$`));
    const loader = (await call("GET", `/r/${site}.js`)).text;
    const rev = /"sv":"([0-9a-z]+)"/.exec(loader)?.[1];
    expect(rev).toBeTruthy();
    const w = await call("GET", `/sv/${site}.${rev}.js`);
    expect(w.headers.get("content-type")).toContain("javascript");
    expect(w.headers.get("cache-control")).toBe("private, max-age=300");
    expect(w.text).toContain(id);
    expect(w.text).toContain("How likely are you to recommend us");
    // owner text can't break out of the inlined config
    await call("PATCH", `/v1/sites/${site}/surveys/${id}`, {
      key,
      body: {
        questions: [
          { type: "nps", text: "</script><script>alert(1)</script>\u2028x", required: true },
          { type: "long_text", text: "Why?" },
        ],
      },
    });
    const rev2 = /"sv":"([0-9a-z]+)"/.exec((await call("GET", `/r/${site}.js`)).text)?.[1];
    const w2 = (await call("GET", `/sv/${site}.${rev2}.js`)).text;
    expect(w2).not.toContain("</script");
    expect(w2).not.toContain("\u2028");
    expect(w2).toContain("\\u003c/script>");
    // a recorded tab, then its answers
    const sid = newSid();
    const T = Date.now() - 30_000;
    await sendChunk(site, sid, 0, [meta(T), snapshot(T + 1), page(T + 5, 1, "/checkout")]);
    expect((await postF({ s: site, sv: id, ver: 1, imp: 1 })).status).toBe(202);
    expect((await postF({ s: site, sv: id, ver: 1, r: rid(), a: { q1: 3 } }, { origin: null })).json.error).toBe("origin_not_allowed");
    expect((await postF({ s: site, sv: id, ver: 1, r: rid(), a: { q1: 42 }, d: 1 })).json.error).toBe("invalid_answer");
    expect((await postF({ s: site, sv: id, ver: 1, r: rid(), a: {}, d: 1 })).json.error).toBe("required_unanswered");
    expect((await postF({ s: site, sv: id, ver: 1, r: rid(), a: {}, nope: 1 })).json.error).toBe("invalid_body");
    const ok = await postF({
      s: site,
      sv: id,
      ver: 1,
      r: rid(),
      sid,
      a: { q1: 3, q2: "Pay button broke, mail me jane@x.test" },
      d: 1,
      p: "/checkout?x=1",
    });
    expect(ok.status).toBe(202);
    expect(ok.json.id).toMatch(/^rsr_/);
    await postF({ s: site, sv: id, ver: 1, r: rid(), a: { q1: 10 }, d: 1, p: "/checkout" }, { ip: "203.0.113.51" });
    const list = (await call("GET", `/v1/sites/${site}/surveys/${id}/responses`, { key })).json;
    expect(list.total).toBe(2);
    const mine = list.responses.find((r: { session_id: string | null }) => r.session_id === sid);
    expect(mine).toMatchObject({
      completed: true,
      // the path came from the page: untrusted like the answers
      untrusted: { path: "/checkout", answers: { q1: 3, q2: "Pay button broke, mail me [email]" } },
    });
    expect((await call("GET", `/v1/sites/${site}/surveys/${id}/responses?nps=detractor`, { key })).json.total).toBe(1);
    const csv = await call("GET", `/v1/sites/${site}/surveys/${id}/responses?format=csv`, { key });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("x-afs-content")).toContain("untrusted");
    expect(csv.text.split("\r\n")[0]).toBe("id,created_at,version,session_id,path,device,country,completed,test,element_selector,q1,q2");
    const res = (await call("GET", `/v1/sites/${site}/surveys/${id}/results`, { key })).json;
    expect(res.funnel).toMatchObject({ shown: 1, started: 2, completed: 2 });
    expect(res.untrusted.questions[0]).toMatchObject({ nps: 0, promoters: 1, detractors: 1 });
    expect((await call("GET", `/v1/sites/${site}/sessions?survey_id=${id}&survey_answer=q1<=6`, { key })).json.total).toBe(1);
    expect((await call("GET", `/v1/sites/${site}/sessions?survey_answer=q1<=6`, { key })).status).toBe(400);
    const tr = (await call("GET", `/v1/sites/${site}/sessions/${sid}/transcript`, { key })).json.transcript;
    expect(tr).toContain('survey "Checkout NPS" answered: q1=3 (detractor)');
    const got = (await call("GET", `/v1/sites/${site}/surveys/${id}`, { key })).json;
    expect(got.stats).toMatchObject({ impressions: 1, started: 2, completed: 2 });
    // the visitor's privacy request takes the linked response with the session
    await call("POST", `/v1/sites/${site}/delete-visitor-data`, { key, body: { session_ids: [sid] } });
    expect((await call("GET", `/v1/sites/${site}/surveys/${id}/responses`, { key })).json.total).toBe(1);
  });

  it("caps per network, max_responses closes the survey, pausing stops answers, previews are test responses", async () => {
    const { key, site } = await newSite("shop.test");
    const env = hosted({ MAX_RESPONSES_PER_NETWORK_PER_SITE_PER_DAY: "1" });
    const c = await call("POST", `/v1/sites/${site}/surveys`, {
      key,
      body: { name: "One", kind: "popover", template: "free_text", status: "active", limits: { max_responses: 2 } },
    });
    const id = c.json.survey.id as string;
    expect((await postF({ s: site, sv: id, r: rid(), a: { q1: "a" }, d: 1 }, { env, ip: "203.0.113.60" })).status).toBe(202);
    const second = await postF({ s: site, sv: id, r: rid(), a: { q1: "b" }, d: 1 }, { env, ip: "203.0.113.60" });
    expect(second.status).toBe(429);
    expect(second.json.error).toBe("network_daily_limit");
    const rev1 = /"sv":"([0-9a-z]+)"/.exec((await call("GET", `/r/${site}.js`)).text)?.[1];
    expect((await postF({ s: site, sv: id, r: rid(), a: { q1: "c" }, d: 1 }, { ip: "203.0.113.61" })).status).toBe(202);
    const after = (await call("GET", `/v1/sites/${site}/surveys/${id}`, { key })).json.survey;
    expect(after).toMatchObject({ status: "closed", closed_reason: "max_responses" });
    expect((await call("GET", `/r/${site}.js`)).text).not.toContain(`"sv":"${rev1}"`);
    expect((await postF({ s: site, sv: id, r: rid(), a: { q1: "d" }, d: 1 }, { ip: "203.0.113.62" })).json.error).toBe("survey_closed");
    // a preview (test) still works on a closed survey, only with test_survey's token, and test_survey sees it
    expect((await postF({ s: site, sv: id, imp: 1, t: 1 })).json.error).toBe("preview_expired");
    expect((await call("GET", `/sv/${site}.p.js?preview=${id}&pt=${"a".repeat(24)}`)).text).not.toContain(id);
    const token = /afsr_survey=rsv_[0-9a-z]{16}\.([0-9a-z]{24})/.exec(
      (await call("POST", `/v1/sites/${site}/surveys/${id}/test`, { key })).json.preview_url,
    )![1]!;
    const pw = await call("GET", `/sv/${site}.p.js?preview=${id}&pt=${token}`);
    expect(pw.headers.get("cache-control")).toBe("no-store");
    expect(pw.text).toContain('"test":1');
    expect(pw.text).toContain(`"pt":"${token}"`);
    expect((await postF({ s: site, sv: id, imp: 1, t: token })).status).toBe(202);
    expect((await postF({ s: site, sv: id, r: rid(), a: { q1: "test" }, d: 1, t: token })).status).toBe(202);
    const t = (await call("POST", `/v1/sites/${site}/surveys/${id}/test`, { key })).json;
    expect(t.preview_url).toContain(token); // reused while valid
    expect(t.checks.find((x: { id: string }) => x.id === "impression_seen").ok).toBe(true);
    expect(t.checks.find((x: { id: string }) => x.id === "response_received").ok).toBe(true);
    expect(t.checks.find((x: { id: string }) => x.id === "active")).toMatchObject({ ok: false });
    expect((await call("GET", `/v1/sites/${site}/surveys/${id}/responses?test=true`, { key })).json.total).toBe(1);
    expect((await call("GET", `/v1/sites/${site}/surveys/${id}/responses`, { key })).json.total).toBe(2);
  });

  it("MAX_ACTIVE_SURVEYS_PER_SITE, versions on question edits, embedded + feedback kinds, MCP tools, deletion", async () => {
    const { key, site } = await newSite("shop.test");
    const env = hosted({ MAX_ACTIVE_SURVEYS_PER_SITE: "1", MAX_SURVEYS_PER_SITE: "3" });
    const a = await call("POST", `/v1/sites/${site}/surveys`, {
      key,
      env,
      body: { name: "A", kind: "feedback", status: "active", allow_element: true },
    });
    expect(a.json.survey.untrusted.questions[0]).toMatchObject({ type: "reaction" });
    const b = await call("POST", `/v1/sites/${site}/surveys`, {
      key,
      env,
      body: { name: "B", kind: "embedded", selector: "#helpful", template: "csat", status: "active" },
    });
    expect(b.json.error.code).toBe("quota_exceeded");
    const b2 = await call("POST", `/v1/sites/${site}/surveys`, {
      key,
      env,
      body: { name: "B", kind: "embedded", selector: "#helpful", template: "csat" },
    });
    expect(b2.status).toBe(201);
    await call("POST", `/v1/sites/${site}/surveys`, { key, env, body: { name: "C", kind: "popover" } });
    expect((await call("POST", `/v1/sites/${site}/surveys`, { key, env, body: { name: "D", kind: "popover" } })).json.error.code).toBe(
      "quota_exceeded",
    );
    const up = await call("PATCH", `/v1/sites/${site}/surveys/${b2.json.survey.id}`, {
      key,
      body: { questions: [{ type: "short_text", text: "Why?" }] },
    });
    expect(up.json.survey.version).toBe(2);
    expect((await call("PATCH", `/v1/sites/${site}/surveys/${b2.json.survey.id}`, { key, body: { kind: "popover" } })).status).toBe(400);
    // feedback element pick is stored as a selector, nothing else
    const fid = a.json.survey.id as string;
    await postF({ s: site, sv: fid, r: rid(), a: { q1: 2 }, d: 1, el: { s: "#pay > button", top: 42 } });
    const fr = (await tool(key, "list_survey_responses", { site_id: site, survey_id: fid })).data;
    expect(fr.responses[0].untrusted.element).toEqual({ selector: "#pay > button", top_pct: 42 });
    const csv = (await tool(key, "list_survey_responses", { site_id: site, survey_id: fid, format: "csv" })).data;
    expect(csv.untrusted.csv).toContain("#pay > button");
    expect(
      (await tool(key, "get_survey_results", { site_id: site, survey_id: fid })).data.untrusted.questions[0].distribution[1],
    ).toMatchObject({ value: 2, count: 1 });
    expect((await tool(key, "list_surveys", { site_id: site })).data.surveys).toHaveLength(3);
    expect((await tool(key, "get_survey", { site_id: site, survey_id: fid })).data.stats.completed).toBe(1);
    expect((await tool(key, "update_survey", { site_id: site, survey_id: fid, status: "paused" })).data.survey.status).toBe("paused");
    expect((await tool(key, "test_survey", { site_id: site, survey_id: fid })).data.preview_url).toContain("afsr_survey=");
    expect((await tool(key, "create_survey", { site_id: site, name: "A", kind: "feedback" })).data.existing).toBe(true);
    const rid1 = fr.responses[0].id;
    expect((await tool(key, "delete_survey_response", { site_id: site, survey_id: fid, response_id: rid1 })).data.deleted).toBe(rid1);
    expect((await tool(key, "delete_survey", { site_id: site, survey_id: fid })).data.deleted).toBe(fid);
    expect((await call("GET", `/v1/sites/${site}/surveys/${fid}`, { key })).status).toBe(404);
  });
});
