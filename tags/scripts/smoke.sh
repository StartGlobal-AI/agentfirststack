#!/usr/bin/env bash
# End-to-end run against `wrangler dev` (needs DEV_MODE=true in .dev.vars for the http webhook).
#   pnpm db:migrate:local && pnpm dev   # in another terminal
#   pnpm smoke                          # or: BASE=http://localhost:8788 bash scripts/smoke.sh
set -euo pipefail
BASE="${BASE:-http://localhost:8788}"
SINK_PORT="${SINK_PORT:-8799}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
SINK_LOG="$TMP/webhook.jsonl"
SECRET="smoke-secret-$(date +%s)-abcdef"
PASS=0
FAIL=0
trap 'kill ${SINK_PID:-0} 2>/dev/null || true; rm -rf "$TMP"' EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2" | head -c 2000; echo; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
api()  { local m=$1 p=$2; shift 2; curl -sS -X "$m" "$BASE$p" -H "authorization: Bearer $KEY" -H 'content-type: application/json' "$@"; }

echo "smoke: $BASE"
curl -sf "$BASE/" >/dev/null || { echo "Worker not reachable at $BASE (run pnpm dev)"; exit 1; }

node "$DIR/webhook-sink.mjs" "$SINK_PORT" "$SINK_LOG" "$SECRET" >/dev/null &
SINK_PID=$!
sleep 0.5

echo "1. signup"
SIGNUP=$(curl -sS -X POST "$BASE/v1/signup")
KEY=$(jq -r .api_key <<<"$SIGNUP")
[[ "$KEY" == tags_* || "$KEY" == afs_* ]] && ok "api key issued" || bad "signup" "$SIGNUP"

echo "2. container (idempotent by domain)"
DOMAIN="smoke-$(date +%s).example.com"
R=$(api POST /v1/containers -d "{\"domain\":\"https://www.$DOMAIN/\"}" -w '\n%{http_code}')
check "create -> 201" "$(tail -1 <<<"$R")" "201"
C=$(head -1 <<<"$R" | jq -r .container.id)
check "domain normalised" "$(head -1 <<<"$R" | jq -r .container.domain)" "$DOMAIN"
R2=$(api POST /v1/containers -d "{\"domain\":\"$DOMAIN\"}" -w '\n%{http_code}')
check "same domain -> 200 existing" "$(tail -1 <<<"$R2") $(head -1 <<<"$R2" | jq -r '.existing,.container.id' | tr '\n' ' ')" "200 true $C "

SCAN=$(api POST "/v1/containers/$C/scan" -d '{"follow_links":false}')
check "scan route answers (unreachable demo domain -> fetch_failed with hint)" "$(jq -r '.error.code // (.detected | type)' <<<"$SCAN")" "fetch_failed"

echo "3. webhook destination (local signed sink)"
D=$(api POST "/v1/containers/$C/destinations" -d "{\"type\":\"webhook\",\"name\":\"smoke sink\",\"credentials\":{\"url\":\"http://127.0.0.1:$SINK_PORT/hook\",\"secret\":\"$SECRET\"}}")
DID=$(jq -r .destination.id <<<"$D")
[[ "$DID" == dst_* ]] && ok "destination $DID" || bad "add destination" "$D"
check "secret not returned" "$(jq -r '.destination.credentials | has("secret")' <<<"$D")" "false"
T=$(api POST "/v1/containers/$C/destinations/$DID/test" -d '{}')
check "destination test delivered (signed)" "$(jq -r '.result.ok, .result.response.signature_valid' <<<"$T" | tr '\n' ' ')" "true true "

echo "4. draft with a purchase conversion"
cat >"$TMP/draft.json" <<JSON
{
  "variables": [
    { "name": "order_value", "type": "data_layer", "key": "ecommerce.value" },
    { "name": "order_currency", "type": "data_layer", "key": "ecommerce.currency" },
    { "name": "order_id", "type": "data_layer", "key": "ecommerce.transaction_id" },
    { "name": "email", "type": "data_layer", "key": "user.email" }
  ],
  "triggers": [
    { "id": "all_pages", "type": "page_view" },
    { "id": "purchase_dl", "type": "custom_event", "event": "purchase" }
  ],
  "tags": [
    { "id": "meta", "type": "meta_pixel", "params": { "pixel_id": "1234567890123456" }, "triggers": ["all_pages"] },
    { "id": "ga4", "type": "ga4", "params": { "measurement_id": "G-SMOKE12345" }, "triggers": ["all_pages"] }
  ],
  "conversions": [{
    "name": "purchase", "trigger": "purchase_dl",
    "value": "order_value", "currency": { "var": "order_currency" }, "transaction_id": "order_id",
    "user_data": { "email": "email" },
    "send_to": { "meta": { "event_name": "Purchase" }, "ga4": { "event_name": "purchase" } },
    "server": true
  }],
  "consent": { "mode": "none", "regions": { "EEA": { "ad_storage": "denied", "ad_user_data": "denied", "ad_personalization": "denied", "analytics_storage": "denied" } } }
}
JSON
P=$(api PUT "/v1/containers/$C/draft" --data-binary @"$TMP/draft.json")
check "draft saved" "$(jq -r .revision <<<"$P")" "2"
BAD=$(api PUT "/v1/containers/$C/draft" -d '{"tags":[{"id":"x","type":"meta_pixel","params":{},"triggers":["nope"]}]}')
check "invalid draft rejected with details" "$(jq -r '.error.code' <<<"$BAD")" "invalid_config"
PATCHED=$(api PATCH "/v1/containers/$C/draft" -d '{"settings":{"phone_country_code":"1"}}')
check "merge patch" "$(jq -r '.config.settings.phone_country_code, (.config.tags|length)' <<<"$PATCHED" | tr '\n' ' ')" "1 2 "

echo "5. validate + publish"
V=$(api POST "/v1/containers/$C/draft/validate")
check "valid" "$(jq -r .valid <<<"$V")" "true"
W=$(jq -r '[.warnings[].code] | join(",")' <<<"$V")
[[ "$W" == *server_without_destination* ]] && ok "warns: server conversion without meta/ga4 destination" || bad "expected server_without_destination warning" "$W"
PUB=$(api POST "/v1/containers/$C/publish" -d '{"note":"smoke"}')
check "published v1" "$(jq -r .version <<<"$PUB")" "1"
check "versions list" "$(api GET "/v1/containers/$C/versions" | jq -r '.versions[0].live')" "true"
PRV=$(api POST "/v1/containers/$C/preview" -d '{}')
[[ "$(jq -r .preview_url <<<"$PRV")" == *afst_preview=prv_* ]] && ok "preview url" || bad "preview" "$PRV"

echo "6. container script"
JS=$(curl -sS -D "$TMP/h" "$BASE/c/$C.js")
grep -q '"G-SMOKE12345"' <<<"$JS" && ok "script has live config" || bad "script config" "$(head -c 300 <<<"$JS")"
ETAG=$(grep -i '^etag:' "$TMP/h" | cut -d' ' -f2- | tr -d '\r')
check "ETag -> 304" "$(curl -s -o /dev/null -w '%{http_code}' -H "if-none-match: $ETAG" "$BASE/c/$C.js")" "304"
check "x-afs-version header" "$(grep -i '^x-afs-version:' "$TMP/h" | cut -d' ' -f2 | tr -d '\r')" "1"
grep -q 'var __AFST__=' <<<"$JS" && ! grep -q '__SGT__\|window.sgt' <<<"$JS" && ok "script uses __AFST__ / afst (no sgt)" || bad "renamed globals"
check "script under a proxy prefix" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/_t/c/$C.js")" "200"
PJS=$(curl -sS "$BASE/c/$C.js?preview=$(jq -r .token <<<"$PRV")")
grep -q '"v":"draft"' <<<"$PJS" && ok "preview serves draft" || bad "preview script"

echo "7. browser /collect: landing visit with a gclid, then the purchase"
VID="smokevid$(date +%s)"
ORIGIN="https://$DOMAIN"
COL=$(curl -sS -X POST "$BASE/_t/collect" -H 'content-type: text/plain' -H "origin: $ORIGIN" -H 'user-agent: Mozilla/5.0 (Macintosh) Chrome/130.0' \
  -d "{\"container_id\":\"$C\",\"type\":\"visit\",\"visitor_id\":\"$VID\",\"page_url\":\"$ORIGIN/?gclid=Cj0KCQsmokegclid&utm_source=google\",\"click_ids\":{\"gclid\":\"Cj0KCQsmokegclid\"},\"utm\":{\"utm_source\":\"google\"},\"consent\":{\"ad_storage\":\"granted\",\"analytics_storage\":\"granted\",\"ad_user_data\":\"granted\",\"ad_personalization\":\"granted\"},\"first_party\":true,\"cookie_domain\":\"$DOMAIN\"}" -D "$TMP/ch")
check "visit accepted" "$(jq -r .ok <<<"$COL")" "true"
grep -qi '^set-cookie: _afst_gclid=Cj0KCQsmokegclid' "$TMP/ch" && ok "first-party Set-Cookie for gclid" || bad "Set-Cookie" "$(cat "$TMP/ch")"
EV="e$(date +%s)smoke"
EMAIL_HASH=$(printf 'jane@example.com' | shasum -a 256 | cut -d' ' -f1)
COL2=$(curl -sS -X POST "$BASE/collect" -H 'content-type: text/plain' -H "origin: $ORIGIN" -H 'user-agent: Mozilla/5.0 (Macintosh) Chrome/130.0' \
  -d "{\"container_id\":\"$C\",\"type\":\"conversion\",\"event_id\":\"$EV\",\"name\":\"purchase\",\"visitor_id\":\"$VID\",\"page_url\":\"$ORIGIN/thank-you\",\"value\":49.5,\"currency\":\"USD\",\"transaction_id\":\"T-SMOKE-1\",\"user_data\":{\"em\":\"$EMAIL_HASH\"},\"fired\":[\"meta_pixel\",\"ga4\"],\"consent\":{\"ad_storage\":\"granted\",\"analytics_storage\":\"granted\",\"ad_user_data\":\"granted\",\"ad_personalization\":\"granted\"}}")
check "conversion queued to webhook" "$(jq -r '.destinations[0].type, .destinations[0].status' <<<"$COL2" | tr '\n' ' ')" "webhook queued "
DUP=$(curl -sS -X POST "$BASE/collect" -H "origin: $ORIGIN" -d "{\"container_id\":\"$C\",\"type\":\"conversion\",\"event_id\":\"$EV\",\"name\":\"purchase\"}")
check "same event_id deduped" "$(jq -r .duplicate <<<"$DUP")" "true"
check "foreign origin rejected" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/collect" -H 'origin: https://evil.test' -d "{\"container_id\":\"$C\",\"type\":\"visit\"}")" "403"
check "unknown container -> 404 (no Durable Object created)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/collect" -H "origin: $ORIGIN" -d '{"container_id":"ctr_smokeneverexisted1","type":"visit"}')" "404"

echo "8. server event joined by visitor id"
S=$(api POST "/v1/containers/$C/events" -d "{\"events\":[{\"name\":\"purchase\",\"order_id\":\"T-SMOKE-2\",\"value\":120,\"currency\":\"USD\",\"email\":\"Jane@Example.com \",\"visitor_id\":\"$VID\"}]}")
check "server event accepted + joined" "$(jq -r '.results[0].status, .results[0].joined.by, (.results[0].joined.click_ids|join(","))' <<<"$S" | tr '\n' ' ')" "accepted visitor_id gclid "
S2=$(api POST "/v1/containers/$C/events" -d "{\"events\":[{\"name\":\"purchase\",\"order_id\":\"T-SMOKE-2\",\"value\":120,\"currency\":\"USD\"}]}")
check "retry with same order_id deduped" "$(jq -r '.results[0].status' <<<"$S2")" "duplicate"

echo "9. event log shows dispatch results"
STATUS=""
for i in $(seq 1 30); do
  LOG=$(api GET "/v1/containers/$C/events?since=10m")
  STATUS=$(jq -r '[.events[] | select(.name=="purchase") | .destinations[0].status] | join(",")' <<<"$LOG")
  [ "$STATUS" = "delivered,delivered" ] && break
  sleep 1
done
check "both purchases delivered to webhook" "$STATUS" "delivered,delivered"
check "delivery http 200 recorded" "$(jq -r '[.events[] | select(.name=="purchase") | .destinations[0].http_status] | join(",")' <<<"$LOG")" "200,200"
SRV=$(jq -c '.events[] | select(.source=="server")' <<<"$LOG")
check "server event carries stored gclid" "$(jq -r '.identity.click_ids | join(",")' <<<"$SRV")" "gclid"
check "sink saw signed payloads with gclid" "$(jq -r 'select(.body.test==false) | [.signature_valid, .body.event.click_ids.gclid] | join(" ")' "$SINK_LOG" | sort -u | tr '\n' '|')" "true Cj0KCQsmokegclid|"
check "plaintext email never forwarded" "$(grep -c 'jane@example.com' "$SINK_LOG" || true)" "0"
VIS=$(api GET "/v1/containers/$C/visitors/$VID")
check "visitor record" "$(jq -r '.visitor.click_ids.gclid.v, .visitor.first_touch.utm_source' <<<"$VIS" | tr '\n' ' ')" "Cj0KCQsmokegclid google "

echo "9b. first-party proxy: X-Forwarded-For trusted only with the container's proxy key"
PKEY=$(api GET "/v1/containers/$C/install" | jq -r .first_party_proxy.proxy_key)
[[ "$PKEY" =~ ^[a-f0-9]{64}$ ]] && ok "install returns a proxy key" || bad "proxy key" "$PKEY"
pvisit() { curl -sS -o /dev/null -X POST "$BASE/_t/collect" -H "origin: $ORIGIN" -H 'user-agent: Mozilla/5.0 Chrome/130.0' -H 'x-forwarded-for: 198.51.100.77' "$@"; }
pvisit -d "{\"container_id\":\"$C\",\"type\":\"visit\",\"visitor_id\":\"${VID}spoof\",\"first_party\":true,\"consent\":{\"analytics_storage\":\"granted\"}}"
pvisit -H "x-afs-proxy-key: $PKEY" -d "{\"container_id\":\"$C\",\"type\":\"visit\",\"visitor_id\":\"${VID}proxy\",\"first_party\":true,\"consent\":{\"analytics_storage\":\"granted\"}}"
check "spoofed X-Forwarded-For ignored without the key" "$(api GET "/v1/containers/$C/visitors/${VID}spoof" | jq -r '.visitor.ip == "198.51.100.77"')" "false"
check "X-Forwarded-For used with the key" "$(api GET "/v1/containers/$C/visitors/${VID}proxy" | jq -r .visitor.ip)" "198.51.100.77"

echo "9c. a forged browser purchase can't suppress the backend's"
FORGED=$(curl -sS -X POST "$BASE/collect" -H 'content-type: text/plain' -H "origin: $ORIGIN" -H 'user-agent: Mozilla/5.0 Chrome/130.0' \
  -d "{\"container_id\":\"$C\",\"type\":\"conversion\",\"event_id\":\"forged$(date +%s)\",\"name\":\"purchase\",\"transaction_id\":\"T-SMOKE-3\",\"value\":99999,\"currency\":\"USD\",\"fired\":[\"ga4\",\"meta_pixel\"],\"consent\":{\"ad_storage\":\"granted\",\"analytics_storage\":\"granted\",\"ad_user_data\":\"granted\",\"ad_personalization\":\"granted\"}}")
check "forged browser hit logged" "$(jq -r .ok <<<"$FORGED")" "true"
S3=$(api POST "/v1/containers/$C/events" -d '{"events":[{"name":"purchase","order_id":"T-SMOKE-3","value":42,"currency":"USD"}]}')
check "backend event with the same order id still accepted" "$(jq -r '.results[0].status, .results[0].event_id, (.results[0].joined.by // "none")' <<<"$S3" | tr '\n' ' ')" "accepted purchase.T-SMOKE-3 none "
V3=""
for i in $(seq 1 30); do
  V3=$(jq -r 'select(.body.event.transaction_id=="T-SMOKE-3" and .body.event.source=="server") | .body.event.value' "$SINK_LOG" | head -1)
  [ -n "$V3" ] && break
  sleep 1
done
check "webhook got the backend's value, not the forged one" "$V3" "42"

echo "10. MCP"
MCP_LIST=$(curl -sS -X POST "$BASE/mcp" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
N=$(jq -r '.result.tools | length' <<<"$MCP_LIST")
[ "$N" -ge 25 ] && ok "tools/list -> $N tools" || bad "tools/list" "$(head -c 500 <<<"$MCP_LIST")"
jq -e '.result.tools[] | select(.name=="setup_conversion_tracking")' <<<"$MCP_LIST" >/dev/null && ok "setup_conversion_tracking listed" || bad "recipe tool missing"
MCP_CALL=$(curl -sS -X POST "$BASE/mcp" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"validate_draft\",\"arguments\":{\"container_id\":\"$C\"}}}")
check "tools/call validate_draft" "$(jq -r '.result.content[0].text | fromjson | .valid' <<<"$MCP_CALL")" "true"
RECIPE=$(curl -sS -X POST "$BASE/mcp" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"setup_conversion_tracking\",\"arguments\":{\"container_id\":\"$C\",\"platforms\":{\"meta\":{\"pixel_id\":\"1234567890123456\"},\"ga4\":{\"measurement_id\":\"G-SMOKE12345\"}},\"conversions\":[{\"name\":\"lead\",\"when\":{\"form_selector\":\"form#contact\"},\"email\":{\"selector\":\"input[type=email]\"}}]}}}")
check "recipe lists missing credentials" "$(jq -r '.result.content[0].text | fromjson | [.missing[].field] | sort | join(",")' <<<"$RECIPE")" "access_token,api_secret"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
