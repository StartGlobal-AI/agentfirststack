#!/usr/bin/env bash
# End-to-end smoke test against a running `wrangler dev` (pnpm db:migrate:local && pnpm dev).
#   bash scripts/smoke.sh [BASE]        BASE defaults to http://localhost:8789
# Needs: curl, jq, node, openssl. Delivers mail through wrangler's local email endpoint
# (POST /cdn-cgi/local/email?from=&to=) and inspects sends through the Local Explorer API.
set -euo pipefail

BASE="${1:-${BASE:-http://localhost:8789}}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIX="$HERE/../test/fixtures"
TMP="$(mktemp -d)"
RECEIVER_PID=""
cleanup() { [ -n "$RECEIVER_PID" ] && kill "$RECEIVER_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

PASS=0
pass() { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2" | head -c 2000; echo; exit 1; }
check() { local name="$1" cond="$2" ctx="${3:-}"; if eval "$cond"; then pass "$name"; else fail "$name" "$ctx"; fi; }

# HTTP helper: sets $CODE and $BODY.
req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" "$BASE$path" -H "authorization: Bearer ${KEY:-}")
  [ -n "$data" ] && args+=(-H 'content-type: application/json' --data "$data")
  CODE=$(curl "${args[@]}")
  BODY=$(cat "$TMP/body")
}
mcp() { # mcp <json-rpc body> -> $BODY = the tool's JSON text (or the raw result)
  CODE=$(curl -s -o "$TMP/mcp" -w '%{http_code}' "$BASE/mcp" -H "authorization: Bearer $KEY" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$1")
  BODY=$(cat "$TMP/mcp")
}
# Deliver a fixture to the local email() handler with the recipient rewritten.
deliver() { # deliver <fixture> <envelope-from> <to>
  sed "s/acme-signups@mail.example.com/$3/g" "$FIX/$1.eml" > "$TMP/$1.eml"
  curl -s -o "$TMP/deliver" -w '%{http_code}' -X POST "$BASE/cdn-cgi/local/email?from=${2//+/%2B}&to=${3//+/%2B}" --data-binary @"$TMP/$1.eml"
}
sent() { curl -s "$BASE/cdn-cgi/local/explorer/api/local/email/sending?per_page=100"; }

echo "mail smoke against $BASE"
curl -sf "$BASE/" > /dev/null || fail "server reachable" "Start it: pnpm db:migrate:local && pnpm dev"
RUN=$(openssl rand -hex 3)

echo "-- signup + inboxes"
KEY="" req POST /v1/signup '{"name":"smoke"}'
check "signup 201" '[ "$CODE" = 201 ]' "$BODY"
KEY=$(jq -r .api_key <<<"$BODY")
DEFAULT_ADDR=$(jq -r .inbox.address <<<"$BODY")
DOMAIN=${DEFAULT_ADDR#*@}
check "signup returns a default inbox" '[[ "$DEFAULT_ADDR" == *@* ]] && [ "$(jq -r .inbox.id <<<"$BODY")" != null ]' "$BODY"

req POST /v1/inboxes "{\"username\":\"smoke-$RUN\",\"display_name\":\"Smoke Test\"}"
check "create inbox 201" '[ "$CODE" = 201 ]' "$BODY"
INBOX=$(jq -r .inbox.id <<<"$BODY"); ADDR=$(jq -r .inbox.address <<<"$BODY")
check "address is username@shared domain" '[ "$ADDR" = "smoke-$RUN@$DOMAIN" ]' "$ADDR"
req POST /v1/inboxes "{\"username\":\"smoke-$RUN\"}"
check "same address again returns existing (200)" '[ "$CODE" = 200 ] && [ "$(jq -r .existing <<<"$BODY")" = true ] && [ "$(jq -r .inbox.id <<<"$BODY")" = "$INBOX" ]' "$BODY"
req POST /v1/inboxes '{"username":"postmaster"}'
check "reserved role address refused (400)" '[ "$CODE" = 400 ]' "$BODY"

echo "-- webhook registration (local receiver)"
HOOK_PORT=$((20000 + RANDOM % 20000))
node "$HERE/webhook-receiver.mjs" "$HOOK_PORT" "$TMP/hooks.jsonl" "$TMP/secret" > "$TMP/receiver.log" 2>&1 &
RECEIVER_PID=$!
sleep 0.5
req POST /v1/webhooks "{\"url\":\"http://127.0.0.1:$HOOK_PORT/hook\",\"events\":[\"message.received\"],\"inbox_id\":\"$INBOX\"}"
check "create webhook 201 with secret" '[ "$CODE" = 201 ] && [[ "$(jq -r .secret <<<"$BODY")" == whsec_* ]]' "$BODY"
jq -r .secret <<<"$BODY" > "$TMP/secret"
HOOK=$(jq -r .webhook.id <<<"$BODY")

echo "-- wait_for_email parks until the email() handler delivers"
WAIT_START=$(date +%s)
curl -s -o "$TMP/wait" -w '%{http_code}' "$BASE/v1/inboxes/$INBOX/wait?from=github&timeout=30" -H "authorization: Bearer $KEY" > "$TMP/wait.code" &
WAIT_PID=$!
sleep 2
DCODE=$(deliver github-launch-code noreply@github.com "$ADDR")
check "local email endpoint accepted the message" '[ "$DCODE" = 200 ]' "$(cat "$TMP/deliver")"
wait "$WAIT_PID"
BODY=$(cat "$TMP/wait")
check "wait returned 200" '[ "$(cat "$TMP/wait.code")" = 200 ]' "$BODY"
check "wait actually parked (waited >= 1.5 s)" '[ "$(jq -r .waited_ms <<<"$BODY")" -ge 1500 ]' "$BODY"
check "extracted code 61873352" '[ "$(jq -r .message.code <<<"$BODY")" = 61873352 ]' "$BODY"
check "extracted verify link" '[[ "$(jq -r .message.verify_link <<<"$BODY")" == https://github.com/account_verifications/confirm/* ]] && [ "$(jq -r .message.verify_link_kind <<<"$BODY")" = verify ]' "$BODY"
MSG=$(jq -r .message.id <<<"$BODY")

req GET "/v1/inboxes/$INBOX/latest-code?from=github.com&after=0&timeout=2"
check "latest-code returns code + link" '[ "$CODE" = 200 ] && [ "$(jq -r .code <<<"$BODY")" = 61873352 ] && [ "$(jq -r .link_kind <<<"$BODY")" = verify ] && [ "$(jq -r .sender_domain <<<"$BODY")" = github.com ]' "$BODY"
req GET "/v1/inboxes/$INBOX/latest-code?after=0&timeout=2"
check "latest-code without from still works for one sender, with a warning" '[ "$CODE" = 200 ] && [ "$(jq -r .code <<<"$BODY")" = 61873352 ] && [ "$(jq -r .warning <<<"$BODY")" != null ]' "$BODY"

req GET "/v1/inboxes/$INBOX/wait?from=nobody-sends-this&timeout=1"
check "wait times out with 408 + hint" '[ "$CODE" = 408 ] && [ "$(jq -r .error.code <<<"$BODY")" = timeout ] && [ "$(jq -r .error.hint <<<"$BODY")" != null ]' "$BODY"

echo "-- extraction on the wire: newsletter has numbers but no code"
DCODE=$(deliver newsletter-numbers hello@devweekly.example "$ADDR")
req GET "/v1/inboxes/$INBOX/wait?from=devweekly&after=0&timeout=5"
check "newsletter stored with codes=[] and no action link" '[ "$(jq -c .message.codes <<<"$BODY")" = "[]" ] && [ "$(jq -r .message.verify_link <<<"$BODY")" = null ]' "$BODY"

echo "-- unknown address is rejected"
DCODE=$(deliver github-launch-code noreply@github.com "nobody-$RUN@$DOMAIN")
check "unknown recipient -> setReject" '[ "$DCODE" = 400 ] && grep -q "Address does not exist" "$TMP/deliver"' "$(cat "$TMP/deliver")"
DCODE=$(deliver tiktok-verification register@account.tiktok.com "smoke-$RUN+tiktok@$DOMAIN")
req GET "/v1/inboxes/$INBOX/latest-code?from=tiktok.com&after=0&timeout=3"
check "plus-address delivered to the base inbox" '[ "$DCODE" = 200 ] && [ "$(jq -r .code <<<"$BODY")" = 739205 ]' "$BODY"
check "latest-code matched the sender domain (subdomain) with an authenticated sender" '[ "$(jq -r .auth_required <<<"$BODY")" = true ] && [ "$(jq -r .auth_verdict <<<"$BODY")" = pass ]' "$BODY"
req GET "/v1/inboxes/$INBOX/latest-code?from=tiktok&after=0&timeout=0"
check "latest-code refuses a bare word as sender (400 + hint)" '[ "$CODE" = 400 ] && jq -r .error.hint <<<"$BODY" | grep -q "from=github.com"' "$BODY"

echo "-- reading"
req GET "/v1/messages/$MSG"
check "get message: text, links, auth" '[ "$CODE" = 200 ] && grep -q "entering the code below" <<<"$(jq -r .message.text <<<"$BODY")" && [ "$(jq -r .message.text_truncated <<<"$BODY")" = false ] && [ "$(jq -r .message.auth.verdict <<<"$BODY")" = pass ] && [ "$(jq ".message.links | length" <<<"$BODY")" -ge 2 ]' "$BODY"
check "REST marks third-party content as untrusted" '[ "$(jq -r "keys_unsorted[0]" <<<"$BODY")" = untrusted ] && jq -r .untrusted.notice <<<"$BODY" | grep -q "^UNTRUSTED CONTENT" && jq -e ".untrusted.fields | index(\"message.text\")" <<<"$BODY" > /dev/null' "$BODY"
MSGID_HEADER=$(jq -r .message.message_id_header <<<"$BODY")
req GET "/v1/messages/$MSG/raw"
check "raw MIME" '[ "$CODE" = 200 ] && grep -q "^Message-ID: <launch-code" <<<"$BODY"' "${BODY:0:300}"
req GET "/v1/inboxes/$INBOX/messages?limit=10"
check "list messages (3 in)" '[ "$CODE" = 200 ] && [ "$(jq ".messages | length" <<<"$BODY")" = 3 ]' "$BODY"
req GET "/v1/search?q=launch%20code"
check "search across inboxes finds the GitHub mail" '[ "$CODE" = 200 ] && [ "$(jq -r ".messages[0].id" <<<"$BODY")" = "$MSG" ]' "$BODY"
req GET "/v1/inboxes/$INBOX/messages?q=survey"
check "per-inbox search finds the newsletter" '[ "$(jq ".messages | length" <<<"$BODY")" = 1 ] && [[ "$(jq -r ".messages[0].subject" <<<"$BODY")" == "Dev Weekly"* ]]' "$BODY"
req PATCH "/v1/messages/$MSG" '{"read":true}'
check "mark read" '[ "$CODE" = 200 ] && [ "$(jq -r .message.read <<<"$BODY")" = true ]' "$BODY"
req GET "/v1/inboxes/$INBOX/messages?unread=true"
check "unread filter excludes it" '[ "$(jq "[.messages[] | select(.id == \"$MSG\")] | length" <<<"$BODY")" = 0 ]' "$BODY"

echo "-- reply + send through the local send_email binding"
req POST "/v1/messages/$MSG/reply" '{"text":"Thanks, signing up now."}'
check "reply 201" '[ "$CODE" = 201 ]' "$BODY"
REPLY_THREAD=$(jq -r .message.thread_id <<<"$BODY"); REPLY_ID=$(jq -r .provider_message_id <<<"$BODY")
req GET "/v1/messages/$MSG"
check "reply stored in the original thread as direction=out" '[ "$REPLY_THREAD" = "$(jq -r .message.thread_id <<<"$BODY")" ]' "$REPLY_THREAD"
SENT=$(sent)
check "binding received the reply with In-Reply-To/References" \
  '[ "$(jq -r --arg id "$REPLY_ID" ".result[] | select(.messageId == \$id) | .headers[\"In-Reply-To\"]" <<<"$SENT")" = "$MSGID_HEADER" ] && [ "$(jq -r --arg id "$REPLY_ID" ".result[] | select(.messageId == \$id) | .subject" <<<"$SENT")" = "Re: 🚀 Your GitHub launch code" ]' "$SENT"
req GET "/v1/threads/$REPLY_THREAD"
check "thread has in + out" '[ "$(jq -r "[.thread.messages[].direction] | join(\",\")" <<<"$BODY")" = "in,out" ]' "$BODY"

ATT=$(printf 'name,code\nsmoke,%s\n' "$RUN" | base64)
req POST "/v1/inboxes/$INBOX/send" "{\"to\":[\"ops@example.org\"],\"cc\":\"cc@example.org\",\"subject\":\"Smoke $RUN\",\"text\":\"Hello from smoke $RUN\",\"html\":\"<p>Hello from <b>smoke</b></p>\",\"attachments\":[{\"filename\":\"smoke.csv\",\"content\":\"$ATT\",\"content_type\":\"text/csv\"}],\"headers\":{\"X-Smoke\":\"$RUN\"}}"
check "send 201 with daily counter" '[ "$CODE" = 201 ] && [ "$(jq -r .recipients <<<"$BODY")" = 2 ] && [ "$(jq -r .daily.used <<<"$BODY")" -ge 3 ]' "$BODY"
SEND_ID=$(jq -r .provider_message_id <<<"$BODY")
SENT=$(sent)
REC=$(jq -c --arg id "$SEND_ID" '.result[] | select(.messageId == $id)' <<<"$SENT")
check "binding got from=inbox, to/cc, attachment, X- header" \
  '[[ "$(jq -r .from <<<"$REC")" == *"$ADDR"* ]] && [ "$(jq -r ".to[0]" <<<"$REC")" = ops@example.org ] && [ "$(jq -r ".attachments[0].filename" <<<"$REC")" = smoke.csv ] && [ "$(jq -r ".headers[\"X-Smoke\"]" <<<"$REC")" = "$RUN" ]' "$REC"
TXT=$(ls -t "$HERE"/../.wrangler/tmp/email/*/email-text/*.txt 2>/dev/null | head -1 || true)
check "local binding wrote the text body to .wrangler/tmp/email" '[ -n "$TXT" ] && grep -q "Hello from smoke $RUN" "$TXT"' "$TXT"
req POST "/v1/inboxes/$INBOX/send" '{"to":"not an address","subject":"x","text":"y"}'
check "invalid recipient -> 400 with hint" '[ "$CODE" = 400 ] && [ "$(jq -r .error.hint <<<"$BODY")" != null ]' "$BODY"

echo "-- custom domain (no Cloudflare API calls; verify uses public DoH)"
# The positive path (challenge passes -> inboxes, mail, sending) needs real DNS; test/integration/security.test.ts covers it.
CDOM="smoke-$RUN.invalid-example.com"
req POST /v1/domains "{\"domain\":\"$CDOM\"}"
check "add domain returns DNS records" '[ "$CODE" = 201 ] && [ "$(jq "[.domain.records[] | select(.value == \"route1.mx.cloudflare.net\")] | length" <<<"$BODY")" = 2 ] && [ "$(jq "[.domain.records[] | select(.name == \"_dmarc.$CDOM\")] | length" <<<"$BODY")" = 1 ]' "$BODY"
CHALLENGE=$(jq -r ".domain.records[0].value" <<<"$BODY")
check "ownership challenge is records[0] with a hint" '[ "$(jq -r ".domain.records[0].name" <<<"$BODY")" = "_afs-verify.$CDOM" ] && [[ "$CHALLENGE" =~ ^afs-verify=[0-9a-f]{32}$ ]] && [ "$(jq -r .domain.ownership <<<"$BODY")" = pending ] && jq -r ".next_steps[0]" <<<"$BODY" | grep -q "_afs-verify.$CDOM"' "$BODY"
req POST /v1/domains "{\"domain\":\"$CDOM\"}"
check "adding again returns the same challenge (200 existing)" '[ "$CODE" = 200 ] && [ "$(jq -r ".domain.records[0].value" <<<"$BODY")" = "$CHALLENGE" ]' "$BODY"
req POST /v1/domains "{\"domain\":\"$CDOM\",\"auto_configure\":true}"
check "auto_configure without CF_API_TOKEN -> 400 with hint" '[ "$CODE" = 400 ] && [ "$(jq -r .error.code <<<"$BODY")" = auto_configure_unavailable ]' "$BODY"
req POST /v1/domains "{\"domain\":\"$CDOM\",\"force\":true}"
check "force without x-admin-token -> 403 admin_required with the records" '[ "$CODE" = 403 ] && [ "$(jq -r .error.code <<<"$BODY")" = admin_required ] && [ "$(jq ".error.details.records | length" <<<"$BODY")" = 12 ]' "$BODY"
req POST "/v1/domains/$CDOM/verify"
check "verify: per-record fail with fixes, ownership first" '[ "$CODE" = 200 ] && [ "$(jq -r .status <<<"$BODY")" = pending ] && [ "$(jq -r .ownership <<<"$BODY")" = fail ] && [ "$(jq -r ".records[0].id" <<<"$BODY")" = ownership_txt ] && [ "$(jq "[.records[] | select(.status == \"fail\" and .fix != null)] | length" <<<"$BODY")" = 12 ]' "$BODY"
req POST /v1/inboxes "{\"username\":\"hello\",\"domain\":\"$CDOM\"}"
check "no inboxes on an unproven domain -> 403 ownership_not_verified" '[ "$CODE" = 403 ] && [ "$(jq -r .error.code <<<"$BODY")" = ownership_not_verified ]' "$BODY"
DCODE=$(deliver stripe-verify-email notifications@stripe.com "anything-$RUN@$CDOM")
check "an unproven domain receives no mail" '[ "$DCODE" = 400 ] && grep -q "Address does not exist" "$TMP/deliver"' "$(cat "$TMP/deliver")"

echo "-- webhook delivery"
for _ in $(seq 1 40); do grep -q '"type":"message.received"' "$TMP/hooks.jsonl" 2>/dev/null && break; sleep 0.5; done
check "message.received delivered with a valid signature" \
  'grep "\"type\":\"message.received\"" "$TMP/hooks.jsonl" | head -1 | jq -e ".verified == true" > /dev/null' "$(cat "$TMP/hooks.jsonl" 2>/dev/null)"
check "payload carries the extracted code" \
  'grep "\"type\":\"message.received\"" "$TMP/hooks.jsonl" | jq -r .body | jq -r .data.message.code | grep -q 61873352' "$(head -c 1500 "$TMP/hooks.jsonl")"
req POST "/v1/webhooks/$HOOK/test"
for _ in $(seq 1 40); do grep -q '"type":"webhook.test"' "$TMP/hooks.jsonl" 2>/dev/null && break; sleep 0.5; done
check "test event delivered + verified" 'grep "\"type\":\"webhook.test\"" "$TMP/hooks.jsonl" | jq -e ".verified == true" > /dev/null' "$(cat "$TMP/hooks.jsonl")"
sleep 1
req GET "/v1/webhooks/$HOOK"
check "delivery log shows delivered" '[ "$(jq -r .webhook.last_delivery.status <<<"$BODY")" = delivered ] && [ "$(jq "[.webhook.deliveries[] | select(.status == \"delivered\")] | length" <<<"$BODY")" -ge 2 ]' "$BODY"

echo "-- MCP"
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
check "tools/list has the spec tools" '[ "$CODE" = 200 ] && for t in create_inbox wait_for_email get_latest_code send_email reply_to_message verify_domain create_webhook; do jq -e --arg t "$t" ".result.tools[] | select(.name == \$t)" <<<"$BODY" > /dev/null || exit 1; done' "${BODY:0:500}"
check "message tools warn that content is untrusted" 'jq -r ".result.tools[] | select(.name == \"get_message\") | .description" <<<"$BODY" | grep -q "untrusted third-party input"' ""
# wait_for_email over MCP while a Slack code arrives
curl -s -o "$TMP/mcpwait" "$BASE/mcp" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"wait_for_email\",\"arguments\":{\"inbox_id\":\"$INBOX\",\"from\":\"slack\",\"timeout\":30}}}" &
MCP_PID=$!
sleep 1.5
DCODE=$(deliver slack-confirm feedback@slack.com "$ADDR")
wait "$MCP_PID"
TOOL=$(jq -r ".result.content[0].text" "$TMP/mcpwait")
check "tools/call wait_for_email -> Slack code 2RK-9QX" '[ "$(jq -r .message.code <<<"$TOOL")" = 2RK-9QX ]' "$(cat "$TMP/mcpwait")"
check "MCP body is fenced as untrusted" 'jq -r .message.untrusted.notice <<<"$TOOL" | grep -q UNTRUSTED' "$TOOL"
mcp "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_latest_code\",\"arguments\":{\"inbox_id\":\"$INBOX\",\"from\":\"github.com\",\"after\":0,\"timeout\":2}}}"
check "tools/call get_latest_code" '[ "$(jq -r ".result.content[0].text" <<<"$BODY" | jq -r .code)" = 61873352 ]' "$BODY"
req POST /v1/keys '{"name":"ro","scope":"read"}'
RO=$(jq -r .api_key <<<"$BODY")
CODE=$(curl -s -o "$TMP/ro" -w '%{http_code}' "$BASE/mcp" -H "authorization: Bearer $RO" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":4,"method":"tools/list"}')
check "read-only key sees no write tools" '! jq -e ".result.tools[] | select(.name == \"send_email\")" "$TMP/ro" > /dev/null && jq -e ".result.tools[] | select(.name == \"wait_for_email\")" "$TMP/ro" > /dev/null' "$(cat "$TMP/ro")"

echo "-- docs + ui"
CODE=$(curl -s -o "$TMP/llms" -w '%{http_code}' "$BASE/llms.txt")
check "/llms.txt documents routes and tools" '[ "$CODE" = 200 ] && grep -q "/v1/inboxes/:id/wait" "$TMP/llms" && grep -q "get_latest_code" "$TMP/llms" && grep -q "after" "$TMP/llms"' ""
CODE=$(curl -s -D "$TMP/uih" -o "$TMP/ui" -w '%{http_code}' "$BASE/ui")
check "/ui is one HTML page with a sandboxed iframe + CSP" '[ "$CODE" = 200 ] && grep -q "setAttribute(\"sandbox\", \"\")" "$TMP/ui" && grep -qi "^content-security-policy: default-src .none." "$TMP/uih"' "$(cat "$TMP/uih")"

echo "-- cleanup"
req DELETE "/v1/inboxes/$INBOX"
check "delete inbox removes it and its blobs" '[ "$CODE" = 200 ] && [ "$(jq -r .blobs_deleted <<<"$BODY")" -ge 3 ]' "$BODY"
check "a deleted shared-domain address is retired for good (address_reserved)" '[ "$(jq -r .address_reserved <<<"$BODY")" = true ]' "$BODY"
req GET "/v1/messages/$MSG"
check "its messages are gone" '[ "$CODE" = 404 ]' "$BODY"
OWNER_KEY=$KEY
KEY="" req POST /v1/signup '{"name":"smoke-2"}'
KEY=$(jq -r .api_key <<<"$BODY")
req POST /v1/inboxes "{\"username\":\"smoke-$RUN\"}"
check "a deleted shared address is never handed to another account (409)" '[ "$CODE" = 409 ] && [ "$(jq -r .error.code <<<"$BODY")" = conflict ]' "$BODY"
KEY=$OWNER_KEY
req POST /v1/inboxes "{\"username\":\"smoke-$RUN\"}"
check "its old owner can create it again (201)" '[ "$CODE" = 201 ]' "$BODY"

echo
printf '\033[32mall %d checks passed\033[0m\n' "$PASS"
