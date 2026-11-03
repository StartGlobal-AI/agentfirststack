import { describe, expect, it } from "vitest";
import { matchIp, parseCidr, parseIp } from "../../src/lib/cidr";
import { compileExclusions, excludedBy, globToRegExp, normalizeExclusions } from "../../src/lib/exclusions";

describe("IP parsing", () => {
  it("IPv4, with no leading zeros", () => {
    expect([...parseIp("203.0.113.7")!]).toEqual([203, 0, 113, 7]);
    expect(parseIp("256.1.1.1")).toBeNull();
    expect(parseIp("010.1.1.1")).toBeNull();
    expect(parseIp("1.2.3")).toBeNull();
    expect(parseIp("")).toBeNull();
  });

  it("IPv6: compression, embedded IPv4, zone ids, brackets", () => {
    expect(parseIp("2001:db8::1")!.length).toBe(16);
    expect([...parseIp("::1")!].slice(-2)).toEqual([0, 1]);
    expect([...parseIp("2001:db8:0:0:0:0:0:1")!]).toEqual([...parseIp("2001:db8::1")!]);
    expect([...parseIp("[fe80::1%eth0]")!]).toEqual([...parseIp("fe80::1")!]);
    expect([...parseIp("64:ff9b::192.0.2.33")!].slice(-4)).toEqual([192, 0, 2, 33]);
    expect(parseIp("2001:db8::1::2")).toBeNull();
    expect(parseIp("2001:db8:::1")).toBeNull();
    expect(parseIp("12345::1")).toBeNull();
    expect(parseIp("1:2:3:4:5:6:7:8:9")).toBeNull();
  });

  it("IPv4-mapped IPv6 is treated as IPv4", () => {
    expect([...parseIp("::ffff:203.0.113.7")!]).toEqual([203, 0, 113, 7]);
    expect([...parseIp("::ffff:cb00:7107")!]).toEqual([203, 0, 113, 7]);
  });
});

describe("CIDR matching", () => {
  it("normalises rules and clears host bits", () => {
    expect(parseCidr("203.0.113.77/24")!.text).toBe("203.0.113.0/24");
    expect(parseCidr("198.51.100.9")!.text).toBe("198.51.100.9");
    expect(parseCidr("2001:DB8:0:0::/32")!.text).toBe("2001:db8::/32");
    expect(parseCidr("::ffff:10.0.0.0/104")!.text).toBe("10.0.0.0/8");
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/x")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
    expect(parseCidr("nope")).toBeNull();
  });

  it("v4 and v6 ranges, non-octet prefixes, families never cross", () => {
    const rules = ["203.0.113.0/24", "10.1.0.0/20", "2001:db8:abcd::/48", "192.0.2.1"].map((r) => parseCidr(r)!);
    expect(matchIp("203.0.113.250", rules)?.text).toBe("203.0.113.0/24");
    expect(matchIp("203.0.114.1", rules)).toBeNull();
    expect(matchIp("10.1.15.255", rules)?.text).toBe("10.1.0.0/20");
    expect(matchIp("10.1.16.0", rules)).toBeNull();
    expect(matchIp("2001:db8:abcd:12::99", rules)?.text).toBe("2001:db8:abcd::/48");
    expect(matchIp("2001:db8:abce::1", rules)).toBeNull();
    expect(matchIp("192.0.2.1", rules)?.text).toBe("192.0.2.1");
    expect(matchIp("::ffff:192.0.2.1", rules)?.text).toBe("192.0.2.1");
    expect(matchIp("garbage", rules)).toBeNull();
    expect(matchIp(null, rules)).toBeNull();
    expect(matchIp("1.2.3.4", [parseCidr("0.0.0.0/0")!])?.text).toBe("0.0.0.0/0");
    expect(matchIp("2001:db8::1", [parseCidr("0.0.0.0/0")!])).toBeNull();
  });
});

describe("exclusions", () => {
  it("validates and normalises input, reporting every problem", () => {
    const { value, problems } = normalizeExclusions({
      ips: ["203.0.113.9/24", "203.0.113.0/24", "bad"],
      paths: ["/admin/*", "admin"],
      hostnames: ["Staging.Example.com", "*.preview.example.com", "bad host"],
      countries: ["de", "USA"],
    });
    expect(value).toEqual({
      ips: ["203.0.113.0/24"],
      paths: ["/admin/*"],
      hostnames: ["staging.example.com", "*.preview.example.com"],
      countries: ["DE"],
    });
    expect(problems).toHaveLength(4);
  });

  it("glob: * matches anything, other characters are literal", () => {
    expect(globToRegExp("/admin/*").test("/admin/users/1")).toBe(true);
    expect(globToRegExp("/admin/*").test("/administrator")).toBe(false);
    expect(globToRegExp("/a.b").test("/axb")).toBe(false);
    expect(globToRegExp("*/preview").test("/blog/post/preview")).toBe(true);
  });

  it("reports the rule that matched, never the IP", () => {
    const c = compileExclusions({ ips: ["2001:db8::/32"], paths: ["/admin/*"], hostnames: ["*.staging.example.com"], countries: ["RU"] });
    expect(excludedBy(c, { ip: "2001:db8::42" })).toEqual({ reason: "excluded_ip", rule: "2001:db8::/32" });
    expect(excludedBy(c, { hostname: "a.staging.example.com" })).toEqual({ reason: "excluded_hostname", rule: "*.staging.example.com" });
    expect(excludedBy(c, { pathname: "/admin/x" })).toEqual({ reason: "excluded_path", rule: "/admin/*" });
    expect(excludedBy(c, { country: "ru" })).toEqual({ reason: "excluded_country", rule: "RU" });
    expect(excludedBy(c, { ip: "203.0.113.1", hostname: "example.com", pathname: "/", country: "DE" })).toBeNull();
    expect(compileExclusions({ ips: [], paths: [], hostnames: [], countries: [] })).toBeNull();
    expect(excludedBy(null, { ip: "1.1.1.1" })).toBeNull();
  });
});
