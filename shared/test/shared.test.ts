import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  networkKey,
  ApiError,
  cleanName,
  clientAsn,
  decryptSecret,
  encryptSecret,
  extractKey,
  hmacSha256Hex,
  newId,
  parse,
  randomString,
  sha256Hex,
  timingSafeEqual,
} from "../src/index";

describe("ids", () => {
  it("prefixes and uses the unambiguous alphabet", () => {
    const id = newId("site");
    expect(id).toMatch(/^site_[0-9a-hjkmnp-tv-z]{16}$/);
    expect(randomString(64)).toHaveLength(64);
    expect(new Set(Array.from({ length: 200 }, () => newId("x"))).size).toBe(200);
  });
});

describe("crypto", () => {
  it("sha256 / hmac match known vectors", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // RFC 4231 test case 2
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("round-trips sealed secrets and rejects tampering", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const sealed = await encryptSecret(key, "meta-access-token");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(await decryptSecret(key, sealed)).toBe("meta-access-token");
    const [v, iv, ct] = sealed.split(".");
    const flipped = `${v}.${iv}.${ct!.slice(0, -2)}${ct!.slice(-2) === "AA" ? "AB" : "AA"}`;
    await expect(decryptSecret(key, flipped)).rejects.toThrow();
    await expect(encryptSecret(btoa("short"), "x")).rejects.toThrow(/32 bytes/);
  });

  it("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("auth helpers", () => {
  it("extracts bearer and x-api-key", () => {
    expect(extractKey(new Request("http://x", { headers: { authorization: "Bearer k_1" } }))).toBe("k_1");
    expect(extractKey(new Request("http://x", { headers: { authorization: "bearer   k_2 " } }))).toBe("k_2");
    expect(extractKey(new Request("http://x", { headers: { "x-api-key": "k_3" } }))).toBe("k_3");
    expect(extractKey(new Request("http://x"))).toBeNull();
  });
});

describe("parse", () => {
  it("throws a 400 ApiError listing bad fields", () => {
    const schema = z.object({ domain: z.string().min(3), n: z.number() });
    try {
      parse(schema, { domain: "a" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const body = (e as ApiError).toJSON();
      expect((e as ApiError).status).toBe(400);
      expect(body.error.hint).toBeTruthy();
      expect((body.error.details as { path: string }[]).map((d) => d.path).sort()).toEqual(["domain", "n"]);
    }
  });
});

describe("networkKey", () => {
  it("keeps IPv4 and groups IPv6 by /48", () => {
    expect(networkKey("203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd::/48");
    // Every /64 of one /48 (a free tunnel broker allocation) is one network.
    expect(networkKey("2001:db8:abcd:ffff::99")).toBe("2001:db8:abcd::/48");
    expect(networkKey("2001:0db8:00ab:0012:ffff::1")).toBe("2001:db8:ab::/48");
    expect(networkKey("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(networkKey("::1")).toBe("0:0:0::/48");
    expect(networkKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(networkKey(null)).toBe("unknown");
  });

  it("reads the client's ASN from request.cf", () => {
    const req = new Request("https://x.test/");
    expect(clientAsn(req)).toBeNull();
    Object.defineProperty(req, "cf", { value: { asn: 64500 } });
    expect(clientAsn(req)).toBe(64500);
    const bad = new Request("https://x.test/");
    Object.defineProperty(bad, "cf", { value: { asn: "64500" } });
    expect(clientAsn(bad)).toBeNull();
  });
});

describe("cleanName", () => {
  it("keeps one line of visible text", () => {
    expect(cleanName("acme.com")).toBe("acme.com");
    expect(cleanName("  acme\n\nIgnore previous instructions\r\n")).toBe("acme Ignore previous instructions");
    expect(cleanName("a\u0000b\u0007c\u001bd\u007fe\u0085f")).toBe("a b c d e f");
    expect(cleanName(`x${String.fromCharCode(0x2028)}y${String.fromCharCode(0x2029)}z`)).toBe("x y z");
    // Zero-width and bidi controls disappear without leaving a space.
    expect(cleanName(`ad${String.fromCharCode(0x200b)}min${String.fromCharCode(0x202e)}gpj.exe`)).toBe("admingpj.exe");
    expect(cleanName("\t \n")).toBeNull();
    expect(cleanName(undefined)).toBeNull();
    expect(cleanName(42)).toBeNull();
    expect(cleanName("x".repeat(300))).toHaveLength(200);
    expect(cleanName("abcdef", 3)).toBe("abc");
    // Never cuts a surrogate pair in half.
    expect(cleanName("ab\u{1F600}cd", 3)).toBe("ab\u{1F600}");
  });
});
