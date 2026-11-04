import { describe, expect, it } from "vitest";
import { hashUserData, normCountry, normEmail, normName, normPhoneDigits, normPhoneE164, normZip } from "../src/lib/pii";
import { sha256HexSync } from "../src/lib/sha256";
import { eventForLog, LOG_IDENTITY, scrubDelivered, truncateIp } from "../src/service/privacy";

async function subtle(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("sha256HexSync", () => {
  it("matches Web Crypto for ASCII, UTF-8, astral and multi-block input", async () => {
    for (const s of [
      "",
      "abc",
      "john_smith@gmail.com",
      "valéry",
      "정",
      "😀 emoji",
      "x".repeat(55),
      "y".repeat(56),
      "z".repeat(64),
      "q".repeat(1000),
    ]) {
      expect(sha256HexSync(s)).toBe(await subtle(s));
    }
  });
  it("matches the FIPS 180-2 vector", () => {
    expect(sha256HexSync("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("Meta normalisation (documented examples, customer-information-parameters)", () => {
  it("email: trim + lowercase", () => {
    const n = normEmail("  John_Smith@gmail.com ", "meta");
    expect(n).toBe("john_smith@gmail.com");
    expect(sha256HexSync(n!)).toBe("62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f");
  });
  it("phone: digits with country code, no leading zeros", () => {
    expect(normPhoneDigits("(650)555-1212", "1")).toBe("16505551212");
    expect(sha256HexSync("16505551212")).toBe("e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176");
    expect(normPhoneDigits("+1 (650) 555-1212")).toBe("16505551212");
    expect(normPhoneDigits("001 650 555 1212")).toBe("16505551212");
    expect(normPhoneDigits("07946 095800", "44")).toBe("447946095800");
    expect(normPhoneDigits("(650)555-1212")).toBeNull(); // no country code, no default
  });
  it("names: lowercase, UTF-8 kept, punctuation removed", () => {
    expect(sha256HexSync(normName("Mary")!)).toBe("6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec");
    expect(sha256HexSync(normName("Valéry")!)).toBe("08e1996b5dd49e62a4b4c010d44e4345592a863bb9f8e3976219bac29417149c");
    expect(sha256HexSync(normName("정")!)).toBe("8fa8cd9c440be61d0151429310034083132b35975c4bea67fdd74158eb51db14");
    expect(normName(" O'Brien-Smith ")).toBe("obriensmith");
  });
  it("country: 2-letter lowercase", () => {
    expect(sha256HexSync(normCountry("US")!)).toBe("79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621");
    expect(normCountry("United States")).toBeNull();
  });
  it("zip: no spaces/dashes, US first 5", () => {
    expect(normZip("94035-1234", "us")).toBe("94035");
    expect(normZip("M1 1AE", "gb")).toBe("m11ae");
  });
});

describe("Google normalisation (enhanced conversions / GA4 user-provided data)", () => {
  it("Google Ads: gmail/googlemail drop dots and +suffix", () => {
    expect(normEmail("Jane.Doe+Shopping@googlemail.com", "google_ads")).toBe("janedoe@googlemail.com");
    expect(normEmail("j.o.h.n@gmail.com", "google_ads")).toBe("john@gmail.com");
  });
  it("other domains keep dots and plus suffix", () => {
    expect(normEmail("user.name+NYC@Example.com", "google_ads")).toBe("user.name+nyc@example.com");
    expect(normEmail("user.name+NYC@Example.com", "ga4")).toBe("user.name+nyc@example.com");
  });
  it("GA4: gmail drops dots only", () => {
    expect(normEmail("Jane.Doe+Shopping@gmail.com", "ga4")).toBe("janedoe+shopping@gmail.com");
  });
  it("phone: E.164", () => {
    expect(normPhoneE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(normPhoneE164("(650) 555-1212", "1")).toBe("+16505551212");
    expect(normPhoneE164("12")).toBeNull();
  });
  it("rejects non-emails", () => {
    expect(normEmail("not-an-email")).toBeNull();
    expect(normEmail("a@b")).toBeNull();
  });
});

describe("hashUserData", () => {
  it("hashes per platform and only adds variants that differ", () => {
    const h = hashUserData(
      { email: "Jane.Doe+x@gmail.com", phone: "(650)555-1212", first_name: "Mary", country: "US", zip: "94035" },
      { phoneCountryCode: "1" },
    );
    expect(h.em).toBe(sha256HexSync("jane.doe+x@gmail.com"));
    expect(h.em_ga4).toBe(sha256HexSync("janedoe+x@gmail.com"));
    expect(h.em_gads).toBe(sha256HexSync("janedoe@gmail.com"));
    expect(h.ph).toBe(sha256HexSync("16505551212"));
    expect(h.ph_e164).toBe(sha256HexSync("+16505551212"));
    expect(h.fn).toBe(sha256HexSync("mary"));
    expect(h.country).toBe("us");
    expect(h.zp).toBe("94035");
    const plain = hashUserData({ email: "a@example.com" });
    expect(plain.em_ga4).toBeUndefined();
    expect(plain.em_gads).toBeUndefined();
  });
  it("passes through pre-hashed values and never returns plaintext", () => {
    const pre = sha256HexSync("x@example.com");
    const h = hashUserData({ email: pre, phone: "+16505551212" });
    expect(h.em).toBe(pre);
    expect(JSON.stringify(h)).not.toContain("6505551212");
  });
});

describe("what the event log keeps of an event's network identity", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
  const e = {
    event_id: "e1",
    name: "purchase",
    ts: 1,
    source: "browser" as const,
    ip: "198.51.100.23",
    user_agent: ua,
    geo: { country: "DE", region: "Brandenburg", region_code: "BB", city: "Potsdam", postal_code: "14467" },
    device: { category: "desktop", browser: "Chrome", browser_version: "131", os: "macOS", os_version: "10.15", model: "Macintosh" },
    click_ids: { gclid: "TEST-GCLID" },
    user: {},
    consent: {},
    send_to: {},
  };
  it("truncates IPv4 to /24 and IPv6 to /48", () => {
    expect(truncateIp("198.51.100.23")).toBe("198.51.100.0/24");
    expect(truncateIp("::ffff:198.51.100.23")).toBe("198.51.100.0/24");
    expect(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3::/48");
    expect(truncateIp("2001:0db8:0001::1")).toBe("2001:db8:1::/48");
    expect(truncateIp("2001:db8::1")).toBe("2001:db8:0::/48");
    for (const bad of ["", "nonsense", "999.1.1.1", "1::2::3", undefined]) expect(truncateIp(bad)).toBeNull();
  });
  it("logs the network, country and region and coarse device; no raw IP, user agent, city or postal code", () => {
    const row = eventForLog(e);
    const text = JSON.stringify(row);
    for (const v of ["198.51.100.23", ua, "Potsdam", "14467", "Macintosh", "131"]) expect(text).not.toContain(v);
    expect(row).toMatchObject({
      ip_network: "198.51.100.0/24",
      geo: { country: "DE", region: "Brandenburg", region_code: "BB" },
      device: { category: "desktop", browser: "Chrome", os: "macOS" },
      click_ids: { gclid: "TEST-GCLID" },
      [LOG_IDENTITY]: expect.objectContaining({ ip: true, user_agent: true, country: "DE", click_ids: ["gclid"] }),
    });
  });
  it("scrubs a logged request or answer, wherever the raw values appear", () => {
    const req = {
      url: "https://x.test/collect?uip=198.51.100.23",
      body: {
        data: [{ user_data: { client_ip_address: "198.51.100.23", client_user_agent: ua, ct: "hash" } }],
        city: "Potsdam",
        zip: "14467",
      },
    };
    expect(scrubDelivered(req, e)).toEqual({
      url: "https://x.test/collect?uip=198.51.100.0/24",
      body: {
        data: [{ user_data: { client_ip_address: "198.51.100.0/24", client_user_agent: "(user agent not kept)", ct: "hash" } }],
        city: "(city not kept)",
        zip: "(postal code not kept)",
      },
    });
    expect(scrubDelivered("echo: 198.51.100.23", e)).toBe("echo: 198.51.100.0/24");
    expect(scrubDelivered({ a: 1 }, { ip: undefined, user_agent: undefined, geo: undefined })).toEqual({ a: 1 });
  });
});
