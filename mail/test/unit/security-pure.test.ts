import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/env";
import { positiveIntVar } from "../../src/env";
import { extractAuth } from "../../src/extract/auth";
import { extractLinks } from "../../src/extract/links";
import { buildDomainRecords, checkDomainDns, evaluateRecord, ownershipRecord } from "../../src/lib/dns";
import { hasControlChars, headerSafe, isMimeType } from "../../src/lib/headers";
import { isOperator } from "../../src/service/domains";
import { MAX_TEXT_BYTES, capText } from "../../src/service/ingest";
import { MAX_RESPONSE_BYTES, chunkForQueue, readCapped } from "../../src/service/webhooks";

const ar = (value: string) => ({ key: "authentication-results", value });

describe("1. operator authorisation (x-admin-token)", () => {
  const env = { ADMIN_TOKEN: "s3cret-operator-token" } as AppEnv;
  it("matches ADMIN_TOKEN exactly, never without one", () => {
    expect(isOperator(env, "s3cret-operator-token")).toBe(true);
    expect(isOperator(env, "s3cret-operator-tokeN")).toBe(false);
    expect(isOperator(env, "s3cret-operator-token ")).toBe(false);
    expect(isOperator(env, "")).toBe(false);
    expect(isOperator(env, null)).toBe(false);
    expect(isOperator({} as AppEnv, "anything")).toBe(false);
    expect(isOperator({ ADMIN_TOKEN: "" } as AppEnv, "")).toBe(false);
  });
});

describe("2. ownership challenge record", () => {
  const rec = ownershipRecord("Acme.com", "0123456789abcdef0123456789abcdef");
  it("is TXT _afs-verify.<domain> = afs-verify=<token>", () => {
    expect(rec).toMatchObject({
      id: "ownership_txt",
      purpose: "ownership",
      type: "TXT",
      name: "_afs-verify.acme.com",
      host: "_afs-verify",
      value: "afs-verify=0123456789abcdef0123456789abcdef",
      match: "txt_exact",
    });
  });
  it("passes only on the exact value", () => {
    expect(evaluateRecord(rec, ["afs-verify=0123456789abcdef0123456789abcdef"]).status).toBe("pass");
    expect(evaluateRecord(rec, ["other", "afs-verify=0123456789abcdef0123456789abcdef"]).status).toBe("pass");
    expect(evaluateRecord(rec, ["afs-verify=ffffffffffffffffffffffffffffffff"]).status).toBe("fail");
    expect(evaluateRecord(rec, ["afs-verify=0123456789abcdef0123456789abcdef-x"]).status).toBe("fail");
    expect(evaluateRecord(rec, []).fix).toMatch(/Add TXT _afs-verify "afs-verify=0123/);
  });
  it("verify reports ownership separately, and as pass when it is not being checked", async () => {
    const fetcher = async (url: string) => {
      const u = new URL(url);
      const hit = u.searchParams.get("name") === "_afs-verify.acme.com" && u.searchParams.get("type") === "TXT";
      return Response.json(
        hit
          ? {
              Status: 0,
              Answer: [{ name: "_afs-verify.acme.com", type: 16, TTL: 60, data: '"afs-verify=0123456789abcdef0123456789abcdef"' }],
            }
          : { Status: 3 },
      );
    };
    const withChallenge = await checkDomainDns("acme.com", [rec, ...buildDomainRecords("acme.com")], fetcher, 1);
    expect(withChallenge).toMatchObject({ ownership: "pass", receiving: "fail", sending: "fail" });
    expect(withChallenge.records[0]).toMatchObject({ id: "ownership_txt", status: "pass" });
    const without = await checkDomainDns("acme.com", buildDomainRecords("acme.com"), fetcher, 1);
    expect(without.ownership).toBe("pass");
    const failing = await checkDomainDns("acme.com", [ownershipRecord("acme.com", "f".repeat(32))], fetcher, 1);
    expect(failing.ownership).toBe("fail");
    expect(failing.next_steps[0]).toMatch(/_afs-verify/);
  });
});

describe("3. stored text cap", () => {
  it("cuts to MAX_TEXT_BYTES of UTF-8 without splitting characters", () => {
    expect(MAX_TEXT_BYTES).toBe(64 * 1024);
    expect(capText("short")).toEqual({ text: "short", truncated: false });
    const ascii = "a".repeat(MAX_TEXT_BYTES + 10);
    expect(capText(ascii)).toEqual({ text: "a".repeat(MAX_TEXT_BYTES), truncated: true });
    const exact = "a".repeat(MAX_TEXT_BYTES);
    expect(capText(exact)).toEqual({ text: exact, truncated: false });
    for (const ch of ["é", "€", "😀"]) {
      const r = capText(ch.repeat(40_000));
      expect(r.truncated).toBe(true);
      const bytes = new TextEncoder().encode(r.text).byteLength;
      expect(bytes).toBeLessThanOrEqual(MAX_TEXT_BYTES);
      expect(bytes).toBeGreaterThan(MAX_TEXT_BYTES - 4);
      expect(r.text).toBe(ch.repeat(r.text.length / ch.length)); // whole characters only
    }
  });
  it("drops absurdly long URLs from extracted links", () => {
    const long = `https://x.example/verify?token=${"a".repeat(5000)}`;
    const links = extractLinks({ text: `Verify your email: ${long}\nhttps://x.example/home` });
    expect(links.map((l) => l.url)).toEqual(["https://x.example/home"]);
  });
});

describe("4. auth verdict: only an authenticated, From-aligned sender passes", () => {
  it("genuine: DMARC pass for the From domain, or aligned DKIM, or aligned SPF", () => {
    expect(
      extractAuth(
        [
          ar(
            "mx.cloudflare.net; dkim=pass header.d=partner.example; spf=pass smtp.mailfrom=jane@partner.example; dmarc=pass header.from=partner.example",
          ),
        ],
        "jane@partner.example",
      ).verdict,
    ).toBe("pass");
    expect(extractAuth([ar("mx.cloudflare.net; dkim=pass header.d=mail.example.com; dmarc=none")], "x@example.com").verdict).toBe("pass");
    expect(
      extractAuth([ar("mx.cloudflare.net; dkim=none; spf=pass smtp.mailfrom=bounce@mail.small.example; dmarc=none")], "x@small.example")
        .verdict,
    ).toBe("pass");
  });
  it("forged: DMARC fail, DMARC pass for another domain, unaligned DKIM/SPF, untrusted headers", () => {
    // Cloudflare's header says fail; a forged pass further down does not matter.
    const forgedBelow = extractAuth(
      [
        ar(
          "mx.cloudflare.net; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=b@evil.example; dmarc=fail header.from=bank.example",
        ),
        ar("mx.bank.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example"),
      ],
      "ceo@bank.example",
    );
    expect(forgedBelow.verdict).toBe("fail");
    // DMARC passed, but for evil.example, not the From domain.
    expect(
      extractAuth(
        [
          ar(
            "mx.cloudflare.net; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=x@evil.example; dmarc=pass header.from=evil.example",
          ),
        ],
        "cfo@corp.example",
      ).verdict,
    ).toBe("unknown");
    // Passing DKIM / SPF for an unrelated domain.
    expect(
      extractAuth(
        [ar("mx.cloudflare.net; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=x@evil.example; dmarc=none")],
        "cfo@corp.example",
      ).verdict,
    ).toBe("unknown");
    // A bare TLD never aligns.
    expect(extractAuth([ar("mx.cloudflare.net; dkim=pass header.d=example; dmarc=none")], "x@corp.example").verdict).toBe("unknown");
    // Only a header the sender wrote.
    expect(extractAuth([ar("mx.victim.example; dmarc=pass header.from=victim.example")], "ops@victim.example").verdict).toBe("unknown");
    expect(extractAuth([], "hr@corp.example").verdict).toBe("unknown");
  });
});

describe("6. webhook fan-out limits", () => {
  it("chunks queue sends to 100 messages and the byte budget", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    expect(chunkForQueue(items, () => 100).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunkForQueue(items.slice(0, 10), () => 60_000, 100, 200_000).map((c) => c.length)).toEqual([3, 3, 3, 1]);
    expect(chunkForQueue([], () => 1)).toEqual([]);
  });
  it("reads at most 64 KB of a response body", async () => {
    let pulled = 0;
    const chunk = 8192;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += chunk;
        c.enqueue(new Uint8Array(chunk).fill(65)); // endless
      },
    });
    const text = await readCapped(body);
    expect(text.length).toBe(MAX_RESPONSE_BYTES);
    expect(pulled).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 2 * chunk);
    expect(await readCapped(null)).toBe("");
  });
});

describe("8. header-bound values", () => {
  it("strips control characters", () => {
    expect(headerSafe("Evil\r\nBcc: victim@example.org")).toBe("Evil Bcc: victim@example.org");
    expect(headerSafe("a\u0000b\u007fc\u2028d\te")).toBe("a b c d e");
    expect(headerSafe("  plain name ")).toBe("plain name");
    expect(headerSafe(null)).toBe("");
    expect(hasControlChars("ok")).toBe(false);
    expect(hasControlChars("a\nb")).toBe(true);
  });
  it("accepts only well-formed MIME types", () => {
    for (const ok of [
      "application/pdf",
      "text/plain; charset=utf-8",
      'text/plain; charset="utf-8"',
      "image/svg+xml",
      "application/vnd.ms-excel",
    ])
      expect(isMimeType(ok)).toBe(true);
    for (const bad of [
      "text/plain\r\nX-Evil: 1",
      "text/html\nContent-Disposition: inline",
      "pdf",
      "text/",
      "a/b; c",
      'text/plain; charset="a\r\nb"',
    ])
      expect(isMimeType(bad)).toBe(false);
  });
});

describe("optional numeric vars", () => {
  it("positive integers, else the fallback", () => {
    expect(positiveIntVar(undefined, 10)).toBe(10);
    expect(positiveIntVar("", 10)).toBe(10);
    expect(positiveIntVar("0", 10)).toBe(10);
    expect(positiveIntVar("abc", 10)).toBe(10);
    expect(positiveIntVar("25", 10)).toBe(25);
    expect(positiveIntVar("2.9", 0)).toBe(2);
  });
});
