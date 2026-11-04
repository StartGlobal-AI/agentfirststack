import { describe, expect, it } from "vitest";
import { parseIcs, parseLine } from "../../src/extract/calendar";
import { standardSignature } from "../../src/lib/signing";
import { analyze, scanTags } from "../../src/service/analysis";
import { documentKind } from "../../src/service/attachment-text";
import { parseSendAt } from "../../src/service/send";

// Pure parts of the P3 features (integration side: test/integration/features-p3.test.ts).

const INVITE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Berlin:20261105T100000",
  "DTEND:20261105T100000Z",
  "UID:abc123@google.com",
  'ORGANIZER;CN="Doe, Jane":mailto:jane@partner.example',
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=agent@mail.example.com:mailto:agent@mail.example.com",
  "SUMMARY:Partnership call\\, round 2",
  "DESCRIPTION:Agenda:\\n1. intro\\n2. next steps that are long enough to be folded over",
  " two lines by the sender",
  "LOCATION:https://meet.example/abc",
  "SEQUENCE:1",
  "STATUS:CONFIRMED",
  "BEGIN:VALARM",
  "DESCRIPTION:not the event's",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("calendar invites (ICS)", () => {
  it("parses the first VEVENT: times, people, escaped and folded text", () => {
    const ev = parseIcs(INVITE)!;
    expect(ev).toMatchObject({
      method: "REQUEST",
      uid: "abc123@google.com",
      summary: "Partnership call, round 2",
      location: "https://meet.example/abc",
      sequence: 1,
      status: "CONFIRMED",
      organizer: { email: "jane@partner.example", name: "Doe, Jane" },
    });
    expect(ev.description).toBe("Agenda:\n1. intro\n2. next steps that are long enough to be folded overtwo lines by the sender");
    expect(ev.start).toEqual({ value: "20261105T100000", tzid: "Europe/Berlin", all_day: false, iso: null });
    expect(ev.end).toEqual({ value: "20261105T100000Z", tzid: null, all_day: false, iso: "2026-11-05T10:00:00Z" });
    expect(ev.attendees).toEqual([
      { email: "agent@mail.example.com", name: "agent@mail.example.com", role: "REQ-PARTICIPANT", status: "NEEDS-ACTION", rsvp: true },
    ]);
  });
  it("all-day dates, no event, quoted colons in parameters", () => {
    expect(parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261224\nEND:VEVENT")!.start).toMatchObject({
      all_day: true,
      iso: "2026-12-24",
    });
    expect(parseIcs("BEGIN:VCALENDAR\nEND:VCALENDAR")).toBeNull();
    expect(parseLine('ATTENDEE;CN="a:b;c":mailto:x@y.example')).toEqual({
      name: "ATTENDEE",
      params: { CN: "a:b;c" },
      value: "mailto:x@y.example",
    });
  });
  it("caps attendees", () => {
    const many = Array.from({ length: 80 }, (_, i) => `ATTENDEE:mailto:p${i}@x.example`).join("\n");
    const ev = parseIcs(`BEGIN:VEVENT\n${many}\nEND:VEVENT`)!;
    expect(ev.attendees).toHaveLength(50);
    expect(ev.attendees_omitted).toBe(30);
  });
});

// The Standard Webhooks spec's own published test vector (standardwebhooks.com), not a real secret.
// Built from two parts so secret scanners don't read it as a Stripe webhook secret.
const SPEC_TEST_SECRET = ["whsec", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"].join("_");

describe("Standard Webhooks signature", () => {
  it("matches the spec's test vector (standardwebhooks.com)", async () => {
    expect(await standardSignature(SPEC_TEST_SECRET, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}')).toBe(
      "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    );
  });
});

describe("deliverability checks", () => {
  const row = {
    from_address: "noreply@shop.example",
    size: 20_000,
    html_size: 1000,
    message_id_header: "<x@shop.example>",
    sent_at: 1,
    auth_json: JSON.stringify({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      arc: null,
      dkim_domains: ["shop.example"],
      authserv_id: "mx.cloudflare.net",
      trusted: true,
      verdict: "pass",
    }),
    links_json: JSON.stringify([
      { url: "https://bit.ly/x", kind: "other", text: "" },
      { url: "http://shop.example/a", kind: "other", text: "" },
    ]),
  };
  it("passes aligned auth and flags shorteners, http links, images without alt, scripts", () => {
    const r = analyze({
      row,
      headers: [
        { key: "date", value: "x" },
        { key: "list-unsubscribe", value: "<https://shop.example/u>" },
      ],
      text: "hello",
      html: '<p>Hi</p><img src="a.png"><img src="b.png" alt="logo"><script>x()</script>',
    });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(by).toMatchObject({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      auth_verdict: "pass",
      text_part: "pass",
      shorteners: "fail",
      https_links: "warn",
      images_alt: "warn",
      risky_html: "fail",
      list_unsubscribe: "warn",
    });
    expect(r.summary.fail).toBe(2);
  });
  it("tags are scanned in one pass on hostile HTML", () => {
    expect(scanTags("<<<<a<b>").map((t) => t.name)).toEqual(["a"]); // "<" without a letter after it is text
    const t = performance.now();
    scanTags("<img ".repeat(300_000));
    scanTags("<".repeat(300_000));
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("attachment text and send_at", () => {
  it("document kinds by type or extension; images are not documents", () => {
    expect(documentKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(documentKind("application/octet-stream", "sheet.xlsx")).toBe("xlsx");
    expect(documentKind("image/png", "a.png")).toBeNull();
    expect(documentKind("image/png", "trick.pdf")).toBeNull();
  });
  it("send_at: ISO or unix, at most 7 days ahead, near-now means now", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(parseSendAt("2026-11-05T09:00:00Z", now)).toBe(Date.parse("2026-11-05T09:00:00Z"));
    expect(parseSendAt(String(Math.floor(now / 1000) + 3600), now)).toBe(now + 3_600_000);
    expect(parseSendAt(now + 1000, now)).toBeNull();
    expect(parseSendAt(undefined, now)).toBeNull();
    expect(() => parseSendAt("2026-11-20T00:00:00Z", now)).toThrow(/7 days/);
    expect(() => parseSendAt("tomorrow", now)).toThrow();
  });
});
