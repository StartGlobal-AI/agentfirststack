// Tiny local webhook receiver for scripts/smoke.sh: verifies x-signature and appends each
// delivery to a JSON-lines file. Usage: node scripts/webhook-sink.mjs <port> <logfile> <secret>
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, log, secret] = process.argv.slice(2);
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const ts = req.headers["x-signature-timestamp"] ?? "";
    const expected = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
    const got = String(req.headers["x-signature"] ?? "");
    const valid = got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {}
    appendFileSync(log, JSON.stringify({ path: req.url, signature_valid: valid, event_id: req.headers["x-event-id"], body: json }) + "\n");
    res.writeHead(valid ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ received: true, signature_valid: valid }));
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`webhook sink on :${port}`));
