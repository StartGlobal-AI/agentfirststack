import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { crawlersReport, recordCrawls } from "../../src/do/crawlers";
import { CRAWLER_PREFILTER, classifyCrawler } from "../../src/lib/crawlers";
import { DAY, NOW, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const UA = {
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  claude: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  chatgptUser: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  human: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  odd: "acme-crawler/0.1",
};

describe("crawlers", () => {
  it("classifies by user agent, specific names first; the prefilter skips humans", () => {
    expect(classifyCrawler(UA.gptbot)).toEqual({ name: "GPTBot", operator: "OpenAI", category: "ai_training" });
    expect(classifyCrawler(UA.claude)).toMatchObject({ name: "ClaudeBot", category: "ai_training" });
    expect(classifyCrawler(UA.chatgptUser)).toMatchObject({ name: "ChatGPT-User", category: "ai_assistant" });
    expect(classifyCrawler(UA.googlebot)).toMatchObject({ name: "Googlebot", category: "search" });
    expect(classifyCrawler("Mozilla/5.0 (compatible; Google-CloudVertexBot)")).toMatchObject({ name: "Google-CloudVertexBot" });
    expect(classifyCrawler(UA.odd)).toEqual({ name: "Other bot", operator: null, category: "other" });
    expect(classifyCrawler(UA.human)).toBeNull();
    expect(CRAWLER_PREFILTER.test(UA.gptbot) && CRAWLER_PREFILTER.test(UA.odd)).toBe(true);
    expect(CRAWLER_PREFILTER.test(UA.human)).toBe(false);
  });

  it("counts per bot and page within a daily budget, apart from events", () => {
    const db = memoryDb();
    const s = settings();
    engine.configure(db, s);
    const hit = (bot: string, category: any, path: string, ts = NOW - 1000, status = 200) => ({
      bot,
      operator: "X",
      category,
      path,
      status,
      ts,
    });
    const r = recordCrawls(
      db,
      [
        hit("GPTBot", "ai_training", "/a"),
        hit("GPTBot", "ai_training", "/a"),
        hit("ClaudeBot", "ai_training", "/b", NOW - 1000, 404),
        hit("Googlebot", "search", "/a", NOW - DAY),
      ],
      s,
      3,
      NOW,
    );
    expect(r).toMatchObject({ counted: 3, refused: 1, used_today: 3 });
    const rep = crawlersReport(db, s, { period: "7d", by: "bot", limit: 10 } as any, NOW) as any;
    expect(rep.results).toEqual([
      expect.objectContaining({ value: "GPTBot", hits: 2, pages: 1, errors: 0 }),
      expect.objectContaining({ value: "ClaudeBot", hits: 1, errors: 1 }),
    ]);
    expect(rep.totals).toMatchObject({ hits: 3, by_category: { ai_training: 3 } });
    const pages = crawlersReport(db, s, { period: "7d", by: "page", category: "ai_training", limit: 10 } as any, NOW) as any;
    expect(pages.results.map((x: any) => [x.value, x.hits])).toEqual([
      ["/a", 2],
      ["/b", 1],
    ]);
    expect(db.all("SELECT COUNT(*) AS n FROM events")[0]!.n).toBe(0);
    // Retention takes old days.
    recordCrawls(db, [hit("GPTBot", "ai_training", "/old", NOW - 1000)], s, 100, NOW);
    db.run("UPDATE crawler_hits SET day = '2020-01-01' WHERE path = '/old'");
    engine.purge(db, 30, NOW);
    expect(db.all("SELECT COUNT(*) AS n FROM crawler_hits WHERE path = '/old'")[0]!.n).toBe(0);
  });
});
