#!/usr/bin/env bash
# End-to-end smoke test against a running `wrangler dev` (pnpm db:migrate:local && pnpm dev).
#   bash scripts/smoke.sh [BASE]        BASE defaults to $BASE, else http://localhost:8790
# Needs: curl, jq, node, gzip. Sends recorder chunks the way the browser does (gzip and plain),
# then reads everything back over REST and MCP, opens a share link, and deletes what it made.
set -euo pipefail

BASE="${1:-${BASE:-http://localhost:8790}}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

PASS=0
pass() { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2" | head -c 2000; echo; exit 1; }
check() { local name="$1" cond="$2" ctx="${3:-}"; if eval "$cond"; then pass "$name"; else fail "$name" "$ctx"; fi; }

# HTTP helper: sets $CODE, $BODY and $HDRS.
req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X "$method" "$BASE$path" -H "authorization: Bearer ${KEY:-}")
  [ -n "$data" ] && args+=(-H 'content-type: application/json' --data "$data")
  CODE=$(curl "${args[@]}")
  BODY=$(cat "$TMP/body")
  HDRS=$(cat "$TMP/headers")
}
mcp() { # mcp <json-rpc body> -> $BODY = the JSON-RPC response
  CODE=$(curl -s -o "$TMP/mcp" -w '%{http_code}' "$BASE/mcp" -H "authorization: Bearer $KEY" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$1")
  BODY=$(cat "$TMP/mcp")
}
# chunk <seq> <z: 1 gzip | 0 plain> <events json array> [extra envelope fields]
chunk() {
  local seq="$1" z="$2" ev="$3" extra="${4:-}"
  printf '{"v":1,"sid":"%s","seq":%s,"t":%s,"ev":%s%s}' "$SID" "$seq" "$(node -e 'console.log(Date.now())')" "$ev" "$extra" > "$TMP/chunk.json"
  if [ "$z" = 1 ]; then gzip -c "$TMP/chunk.json" > "$TMP/chunk.bin"; else cp "$TMP/chunk.json" "$TMP/chunk.bin"; fi
  CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST "$BASE/i?s=$SITE&sid=$SID&q=$seq&z=$z" \
    -H 'content-type: text/plain' -H "user-agent: $UA" -H "origin: https://$DOMAIN" --data-binary @"$TMP/chunk.bin")
  BODY=$(cat "$TMP/body")
}

echo "replay smoke against $BASE"
curl -sf "$BASE/" > /dev/null || fail "server reachable" "Start it: pnpm db:migrate:local && pnpm dev (or set BASE)"
RUN=$(node -e 'console.log(Math.random().toString(36).slice(2, 8))')
DOMAIN="smoke-$RUN.example"
SID="rs_$(node -e 'const a="0123456789abcdefghjkmnpqrstvwxyz";let s="";for(let i=0;i<16;i++)s+=a[Math.floor(Math.random()*32)];console.log(s)')"

echo "-- signup + site"
KEY="" req POST /v1/signup '{"name":"replay smoke"}'
check "signup 201" '[ "$CODE" = 201 ]' "$BODY"
KEY=$(jq -r .api_key <<<"$BODY")
req POST /v1/sites "{\"domain\":\"$DOMAIN\",\"unmask_selectors\":[\"button\",\"nav\"]}"
check "create site 201 with snippet" '[ "$CODE" = 201 ] && [[ "$(jq -r .site.snippet <<<"$BODY")" == *"/r/rsite_"* ]]' "$BODY"
SITE=$(jq -r .site.id <<<"$BODY")
req POST /v1/sites "{\"domain\":\"$DOMAIN\"}"
check "same domain again returns existing (200)" '[ "$CODE" = 200 ] && [ "$(jq -r .existing <<<"$BODY")" = true ]' "$BODY"
req PATCH "/v1/sites/$SITE" '{"unmask_selectors":["a{"]}'
check "bad selector refused with a hint (400)" '[ "$CODE" = 400 ] && [ "$(jq -r .error.hint <<<"$BODY")" != null ]' "$BODY"

echo "-- browser scripts"
req GET "/r/$SITE.js"
check "loader served with the site config" '[ "$CODE" = 200 ] && [[ "$BODY" == "/*! afs-replay $SITE */"* ]] && [[ "$BODY" == *"\"unmask\":\"button,nav\""* ]]' "${BODY:0:300}"
REC=$(grep -o '/recorder\.[0-9a-f]*\.js' <<<"$BODY" | head -1)
req GET "$REC"
check "recorder served, immutable" '[ "$CODE" = 200 ] && [[ "$BODY" == "/*! afs-replay recorder"* ]] && grep -qi "immutable" <<<"$HDRS"' "$REC"

echo "-- ingest (as the recorder sends it)"
T=$(node -e 'console.log(Date.now() - 60000)')
EV0="[{\"type\":4,\"timestamp\":$T,\"data\":{\"href\":\"https://$DOMAIN/checkout\",\"width\":1440,\"height\":900}},{\"type\":2,\"timestamp\":$((T + 1)),\"data\":{\"node\":{\"type\":0,\"id\":1,\"childNodes\":[]},\"initialOffset\":{\"top\":0,\"left\":0}}},{\"type\":5,\"timestamp\":$((T + 5)),\"data\":{\"tag\":\"afs.page\",\"payload\":{\"pv\":1,\"p\":\"/checkout\",\"h\":\"$DOMAIN\",\"nav\":\"load\",\"w\":1440,\"vh\":900,\"dh\":2400}}}]"
chunk 0 1 "$EV0" ',"uid":"smoke-user"'
check "gzip chunk accepted (202)" '[ "$CODE" = 202 ] && [ "$(jq -r .new_session <<<"$BODY")" = true ]' "$BODY"
click() { printf '{"type":5,"timestamp":%s,"data":{"tag":"afs.click","payload":{"pv":1,"s":"#pay","l":"Pay","tg":"button","i":1,"x":600,"y":700,"w":1440,"dh":2400,"top":28}}}' "$1"; }
EV1="[$(click $((T + 3000))),$(click $((T + 3200))),$(click $((T + 3400))),{\"type\":5,\"timestamp\":$((T + 3500)),\"data\":{\"tag\":\"afs.error\",\"payload\":{\"pv\":1,\"k\":\"error\",\"m\":\"TypeError: card is undefined\",\"src\":\"https://$DOMAIN/app.js\",\"ln\":1,\"col\":99}}},{\"type\":5,\"timestamp\":$((T + 4000)),\"data\":{\"tag\":\"afs.scroll\",\"payload\":{\"pv\":1,\"y\":1500,\"dh\":2400,\"vh\":900}}},{\"type\":5,\"timestamp\":$((T + 9000)),\"data\":{\"tag\":\"afs.hide\",\"payload\":{\"pv\":1,\"k\":\"pagehide\"}}}]"
chunk 1 0 "$EV1" ',"end":1,"uid":"smoke-user"'
check "plain (pagehide) chunk accepted (202)" '[ "$CODE" = 202 ]' "$BODY"
chunk 1 0 "$EV1" ',"end":1'
check "same seq again is a no-op" '[ "$(jq -r .duplicate <<<"$BODY")" = true ]' "$BODY"
CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST "$BASE/i?s=$SITE&sid=$SID&q=2&z=0" -H "user-agent: $UA" -H "origin: https://evil.example" --data-binary '{"v":1}')
check "foreign origin refused (403)" '[ "$CODE" = 403 ] && [ "$(jq -r .error "$TMP/body")" = origin_not_allowed ]' "$(cat "$TMP/body")"

echo "-- read: sessions, transcript, summary, heatmap, errors, funnel"
req GET "/v1/sites/$SITE/sessions?signal=rage_click"
check "search finds the rage-click session" '[ "$(jq -r .total <<<"$BODY")" = 1 ] && [ "$(jq -r .sessions[0].id <<<"$BODY")" = "$SID" ]' "$BODY"
req GET "/v1/sites/$SITE/sessions/$SID/transcript"
check "transcript shows the burst, the error and the fence" 'jq -r .transcript <<<"$BODY" | grep -q "RAGE" && jq -r .transcript <<<"$BODY" | grep -q "card is undefined" && jq -r .transcript <<<"$BODY" | grep -q "<<<UNTRUSTED_REPLAY_TRANSCRIPT_"' "$BODY"
req GET "/v1/sites/$SITE/summary?period=24h"
check "summary groups the rage target" '[ "$(jq -r .untrusted.top_rage_targets[0].selector <<<"$BODY")" = "#pay" ]' "$BODY"
req GET "/v1/sites/$SITE/heatmap?page=/checkout"
check "heatmap: 3 clicks on #pay, scroll reach" '[ "$(jq -r .untrusted.elements[0].clicks <<<"$BODY")" = 3 ] && [ "$(jq -r .scroll.pageviews <<<"$BODY")" = 1 ]' "$BODY"
req GET "/v1/sites/$SITE/errors"
check "errors grouped with the triggering click" '[ "$(jq -r .untrusted.errors[0].triggered_by[0].selector <<<"$BODY")" = "#pay" ]' "$BODY"
req GET "/v1/sites/$SITE/funnel?steps=/checkout,/thanks&drop_step=1"
check "funnel drop-off lists the session" '[ "$(jq -r .dropped.total <<<"$BODY")" = 1 ]' "$BODY"

echo "-- MCP"
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
check "19 tools" '[ "$(jq ".result.tools | length" <<<"$BODY")" = 19 ]' "$BODY"
mcp "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_session_transcript\",\"arguments\":{\"site_id\":\"$SITE\",\"session_id\":\"$SID\",\"kinds\":[\"error\"]}}}"
check "get_session_transcript over MCP" 'jq -r ".result.content[0].text" <<<"$BODY" | grep -q "card is undefined"' "$BODY"

echo "-- share link + player"
req POST "/v1/sites/$SITE/links" "{\"session_id\":\"$SID\",\"expires_in\":600}"
check "share link created (201)" '[ "$CODE" = 201 ]' "$BODY"
PLAY=$(jq -r .link.url <<<"$BODY" | sed -E 's#^https?://[^/]+##')
LINK=$(jq -r .link.id <<<"$BODY")
req GET "$PLAY"
check "player page with a strict CSP" '[ "$CODE" = 200 ] && grep -qi "content-security-policy: default-src .none." <<<"$HDRS"' "$HDRS"
req GET "$PLAY/data"
check "player data: chunks 0 and 1" '[ "$(jq -c .chunks <<<"$BODY")" = "[0,1]" ]' "$BODY"
curl -s "$BASE$PLAY/chunks/0" | gunzip | jq -e ".ev[1].type == 2" > /dev/null && pass "chunk 0 is gzip with the snapshot" || fail "chunk 0 is gzip with the snapshot"
req DELETE "/v1/sites/$SITE/links/$LINK"
req GET "$PLAY"
check "revoked link is gone (404)" '[ "$CODE" = 404 ]' "$CODE"

echo "-- verify, privacy deletion, cleanup"
req POST "/v1/sites/$SITE/verify" '{}'
check "verify reports sessions received" '[ "$(jq -r .receiving_sessions <<<"$BODY")" = true ]' "$BODY"
req POST "/v1/sites/$SITE/delete-visitor-data" '{"user_id":"smoke-user"}'
check "delete_visitor_data removes the session" '[ "$(jq -r .deleted_sessions <<<"$BODY")" = 1 ]' "$BODY"
req DELETE "/v1/sites/$SITE"
check "site deleted" '[ "$CODE" = 200 ]' "$BODY"

printf '\n\033[32m%s checks passed\033[0m\n' "$PASS"
