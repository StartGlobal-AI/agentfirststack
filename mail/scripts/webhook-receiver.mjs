// Tiny webhook receiver for scripts/smoke.sh.
//   node scripts/webhook-receiver.mjs <port> <out.jsonl> <secret-file>
// Appends one JSON line per POST: { verified, type, headers, body }. The signature is checked
// against the secret in <secret-file> (read on every request, so it can be written after start).
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, out, secretFile] = process.argv.slice(2);
if (!port || !out || !secretFile) {
  console.error("usage: webhook-receiver.mjs <port> <out.jsonl> <secret-file>");
  process.exit(2);
}

function verify(secret, header, body) {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.trim().split("=")));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${body}`).digest("hex");
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let secret = "";
    try {
      secret = readFileSync(secretFile, "utf8").trim();
    } catch {}
    const verified = !!secret && verify(secret, req.headers["x-signature"], body);
    let type = null;
    try {
      type = JSON.parse(body).type;
    } catch {}
    appendFileSync(out, JSON.stringify({ verified, type, headers: req.headers, body }) + "\n");
    res.writeHead(verified ? 200 : 401, { "content-type": "text/plain" });
    res.end(verified ? "ok" : "bad signature");
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`webhook receiver on :${port}`));
