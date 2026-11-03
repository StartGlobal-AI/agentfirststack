// Builds the generated discovery files in public/ before every `wrangler dev` / deploy:
//   .well-known/agent-skills/index.json  (Agent Skills Discovery v0.2.0, with sha256 digests)
// Digests must match the served bytes exactly, so they are recomputed from the files on disk.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ORIGIN = "https://agentfirststack.com";
const SKILLS = join(PUBLIC, ".well-known", "agent-skills");

const skills = [];
for (const name of readdirSync(SKILLS).sort()) {
  const dir = join(SKILLS, name);
  if (!statSync(dir).isDirectory()) continue;
  const file = join(dir, "SKILL.md");
  const bytes = readFileSync(file);
  const front = /^---\n([\s\S]*?)\n---/.exec(bytes.toString("utf8"))?.[1] ?? "";
  const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim();
  if (field("name") !== name) throw new Error(`${file}: frontmatter name must be "${name}"`);
  skills.push({
    name,
    type: "skill-md",
    description: field("description") ?? "",
    url: `${ORIGIN}/.well-known/agent-skills/${name}/SKILL.md`,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}

const index = { $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills };
const out = join(SKILLS, "index.json");
const next = `${JSON.stringify(index, null, 2)}\n`;
// Write only on change: the file sits inside the dev server's watch dir, so an unconditional
// write would trigger an endless rebuild loop.
let prev = "";
try {
  prev = readFileSync(out, "utf8");
} catch {}
if (prev !== next) writeFileSync(out, next);
console.log(`agent-skills: ${skills.map((s) => s.name).join(", ")}${prev === next ? " (unchanged)" : ""}`);
