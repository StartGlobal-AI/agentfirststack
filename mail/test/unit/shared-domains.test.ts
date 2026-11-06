import { describe, expect, it } from "vitest";
import { sharedDomainsOf } from "../../src/lib/shared-domains";

describe("sharedDomainsOf", () => {
  it("one shared domain without SHARED_INBOX_DOMAIN: MAIL_DOMAIN for everything, as before", () => {
    expect(sharedDomainsOf({ MAIL_DOMAIN: "Mail.Example.com" })).toEqual({
      primary: "mail.example.com",
      all: ["mail.example.com"],
      legacy: [],
      sending: ["mail.example.com"],
    });
    expect(sharedDomainsOf({}).primary).toBe("mail.example.com");
  });

  it("SHARED_INBOX_DOMAIN takes new inboxes; MAIL_DOMAIN stays shared and keeps sending", () => {
    const sd = sharedDomainsOf({ MAIL_DOMAIN: "agentfirststack.com", SHARED_INBOX_DOMAIN: " AgentFirstInbox.com. " });
    expect(sd).toEqual({
      primary: "agentfirstinbox.com",
      all: ["agentfirstinbox.com", "agentfirststack.com"],
      legacy: ["agentfirststack.com"],
      // Not onboarded until the operator lists it.
      sending: ["agentfirststack.com"],
    });
  });

  it("SHARED_SENDING_DOMAINS lists the onboarded shared domains; others (custom, typos) are ignored", () => {
    const base = { MAIL_DOMAIN: "agentfirststack.com", SHARED_INBOX_DOMAIN: "agentfirstinbox.com" };
    expect(sharedDomainsOf({ ...base, SHARED_SENDING_DOMAINS: "agentfirststack.com, agentfirstinbox.com" }).sending).toEqual([
      "agentfirstinbox.com",
      "agentfirststack.com",
    ]);
    // The operator may stop shared inboxes sending from the main domain.
    expect(sharedDomainsOf({ ...base, SHARED_SENDING_DOMAINS: "agentfirstinbox.com,shop.example" }).sending).toEqual([
      "agentfirstinbox.com",
    ]);
  });

  it("a SHARED_INBOX_DOMAIN that isn't a hostname, or equals MAIL_DOMAIN, changes nothing", () => {
    for (const v of ["", "  ", "not a domain", "https://x.example/"])
      expect(sharedDomainsOf({ MAIL_DOMAIN: "mail.example.com", SHARED_INBOX_DOMAIN: v }).all).toEqual(["mail.example.com"]);
    expect(sharedDomainsOf({ MAIL_DOMAIN: "mail.example.com", SHARED_INBOX_DOMAIN: "MAIL.example.com" })).toMatchObject({
      all: ["mail.example.com"],
      legacy: [],
    });
  });
});
