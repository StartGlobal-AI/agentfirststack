import { describe, expect, it } from "vitest";
import repoSkill from "../../skills/agentfirststack-setup/SKILL.md?raw";
import siteSkill from "../public/.well-known/agent-skills/agentfirststack-setup/SKILL.md?raw";
import index from "../public/.well-known/agent-skills/index.json";

// The setup skill is published twice: in the repo's skills/ folder (where `npx skills add
// StartGlobal-AI/agentfirststack` and skills.sh find it) and on the site under /.well-known (agent
// skills discovery, which pins it by digest). Both have to say the same thing.
describe("the agentfirststack-setup skill", () => {
  it("has frontmatter a YAML parser reads as plain strings", () => {
    // An unquoted ": " or " #" in a value is a nested mapping or a comment to YAML, and the skills
    // CLI (and agents that load skills) then skip the whole skill.
    const front = /^---\n([\s\S]*?)\n---\n/.exec(siteSkill)?.[1] ?? "";
    const fields = Object.fromEntries(front.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.name).toBe("agentfirststack-setup");
    for (const value of Object.values(fields)) {
      expect(value).not.toMatch(/: | #|^["'&*!|>%@`[{]/);
    }
  });

  it("is the same file in skills/ and on the site", () => {
    expect(repoSkill).toBe(siteSkill);
  });

  it("matches the discovery index: description and digest", async () => {
    const entry = index.skills.find((s) => s.name === "agentfirststack-setup");
    expect(entry).toBeDefined();
    const description = /^description: (.*)$/m.exec(siteSkill)?.[1];
    expect(entry?.description).toBe(description);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(siteSkill));
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(entry?.digest).toBe(`sha256:${hex}`);
  });
});
