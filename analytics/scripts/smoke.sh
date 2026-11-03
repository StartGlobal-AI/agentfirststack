#!/usr/bin/env bash
# End-to-end smoke test against a running analytics Worker. Starts nothing itself.
#   pnpm db:migrate:local && pnpm dev   # in another shell (needs .dev.vars with DEV_MODE=true)
#   pnpm smoke                          # or BASE=https://... bash scripts/smoke.sh
# Each run uses a fresh account and site, so every count below is exact.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
command -v jq >/dev/null || { echo "smoke.sh needs jq"; exit 2; }

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$(printf '%s' "$2" | head -c 600)"; return 0; }
# check <description> <jq boolean expression> <json>
check() { if printf '%s' "$3" | jq -e "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1  [$2]" "$3"; fi; }

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
api() { # api METHOD PATH [JSON]
  local m="$1" p="$2"
  if [ $# -ge 3 ]; then curl -sS -X "$m" "$BASE$p" -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d "$3"
  else curl -sS -X "$m" "$BASE$p" -H "Authorization: Bearer $KEY"; fi
}
# collect IP COUNTRY CITY CONTINENT JSON  (a beacon as a first-party proxy forwards it: the visitor IP
# in X-Forwarded-For counts only with the site's proxy key $PK; dev geo headers need DEV_MODE=true)
collect() {
  curl -sS -X POST "$BASE${PREFIX:-}/e" -A "$UA" -H "content-type: text/plain" -H "x-forwarded-for: $1" -H "x-afs-proxy-key: $PK" \
    -H "x-dev-geo-country: $2" -H "x-dev-geo-city: $3" -H "x-dev-geo-continent: ${4:-}" -d "$5"
}

echo "smoke: $BASE"

echo "- public endpoints"
JS=$(curl -sS "$BASE/s.js")
check "/s.js serves the tracker" '. == true' "$(printf '%s' "$JS" | grep -q 'afs-analytics' && echo true || echo false)"
check "/s.js exposes window.afsa and keeps afsa_* storage keys (no sga left)" '. == true' "$(printf '%s' "$JS" | grep -q 'afsa_vid' && printf '%s' "$JS" | grep -q 'afsa_ignore' && ! printf '%s' "$JS" | grep -q 'sga' && echo true || echo false)"
JS2=$(curl -sS "$BASE/_a/s.js")
check "/_a/s.js (proxy prefix) serves the tracker" '. == true' "$(printf '%s' "$JS2" | grep -q 'afs-analytics' && echo true || echo false)"
LLMS=$(curl -sS "$BASE/llms.txt")
check "/llms.txt documents routes and MCP tools" '. == true' "$(printf '%s' "$LLMS" | grep -q '## MCP tools' && printf '%s' "$LLMS" | grep -q '/v1/sites/:id/funnel' && echo true || echo false)"

echo "- signup + site"
SIGNUP=$(curl -sS -X POST "$BASE/v1/signup" -d '{"name":"smoke"}')
KEY=$(printf '%s' "$SIGNUP" | jq -r .api_key)
check "signup returns an API key" '.api_key | test("^(ana|afs)_")' "$SIGNUP"
DOMAIN="smoke-$RANDOM$RANDOM.example.com"
SITE_JSON=$(api POST /v1/sites "{\"domain\":\"https://www.$DOMAIN/\",\"name\":\"Smoke\",\"timezone\":\"UTC\"}")
SITE=$(printf '%s' "$SITE_JSON" | jq -r .site.id)
PK=$(printf '%s' "$SITE_JSON" | jq -r .install.first_party_proxy.proxy_key)
check "create site normalises the domain" ".site.domain == \"$DOMAIN\" and .existing == false" "$SITE_JSON"
check "install: queue stub is window.afsa, every proxy snippet carries the proxy key" "(.install.install.code | contains(\"window.afsa=window.afsa\")) and ([.install.first_party_proxy | .cloudflare_worker, .nextjs, .vercel, .netlify, .nginx | .code | contains(\"$PK\")] | all) and (.install.first_party_proxy.cloudflare_worker.code | contains(\"x-afs-geo-\")) and (tostring | test(\"sga|x-sg-\") | not)" "$SITE_JSON"
check "create site returns snippet + proxy + next_steps" '(.install.snippet | contains("data-site")) and (.install.first_party_proxy.cloudflare_worker.code | length > 0) and (.next_steps | length > 0)' "$SITE_JSON"
AGAIN=$(api POST /v1/sites "{\"domain\":\"$DOMAIN\"}")
check "create site is idempotent by domain" ".existing == true and .site.id == \"$SITE\"" "$AGAIN"
INSTALL=$(api GET "/v1/sites/$SITE/install?framework=nextjs")
check "install instructions for nextjs" '.install.file == "app/layout.tsx" and (.first_party_proxy.nginx.code | contains("proxy_pass"))' "$INSTALL"

echo "- browser events (/e) from 5 visitors in 5 countries"
U="https://$DOMAIN"
check "V1 DE pageview / from Google" '.ok == true' "$(collect 10.0.0.1 DE Berlin EU "{\"s\":\"$SITE\",\"u\":\"$U/\",\"r\":\"https://www.google.com/\"}")"
check "V1 DE pageview /pricing" '.ok == true' "$(collect 10.0.0.1 DE Berlin EU "{\"s\":\"$SITE\",\"u\":\"$U/pricing\",\"r\":\"$U/\"}")"
check "V1 DE event signup" '.ok == true' "$(collect 10.0.0.1 DE Berlin EU "{\"s\":\"$SITE\",\"n\":\"signup\",\"u\":\"$U/pricing\",\"p\":{\"plan\":\"pro\"}}")"
check "V1 engagement beacon" '.ok == true' "$(collect 10.0.0.1 DE Berlin EU "{\"s\":\"$SITE\",\"n\":\"engagement\",\"e\":5000,\"u\":\"$U/pricing\"}")"
check "V2 US pageview from ChatGPT (utm_source)" '.ok == true and (.v | length) == 16' "$(collect 10.0.0.2 US 'San Francisco' NA "{\"s\":\"$SITE\",\"u\":\"$U/?utm_source=chatgpt.com\"}")"
check "V2 US pageview /pricing via proxy prefix /_a/e" '.ok == true' "$(PREFIX=/_a collect 10.0.0.2 US 'San Francisco' NA "{\"s\":\"$SITE\",\"u\":\"$U/pricing\",\"r\":\"$U/\"}")"
check "V2 US revenue purchase 49 USD" '.ok == true' "$(collect 10.0.0.2 US 'San Francisco' NA "{\"s\":\"$SITE\",\"n\":\"purchase\",\"u\":\"$U/checkout\",\"\$\":[49,\"USD\"]}")"
check "V3 IN pageview /pricing with gclid" '.ok == true' "$(collect 10.0.0.3 IN Mumbai AS "{\"s\":\"$SITE\",\"u\":\"$U/pricing?gclid=Cj0KCQ\"}")"
check "V4 US direct pageview /blog/hello" '.ok == true' "$(collect 10.0.0.4 US 'New York' NA "{\"s\":\"$SITE\",\"u\":\"$U/blog/hello\"}")"
check "V5 FR pageview from Facebook" '.ok == true' "$(collect 10.0.0.5 FR Paris EU "{\"s\":\"$SITE\",\"u\":\"$U/\",\"r\":\"https://l.facebook.com/\"}")"
BOT=$(curl -sS -X POST "$BASE/e" -A "curl/8.4.0" -d "{\"s\":\"$SITE\",\"u\":\"$U/\"}")
check "bots are dropped" '.ok == false and .dropped == "bot"' "$BOT"
UNKNOWN=$(curl -sS -X POST "$BASE/e" -A "$UA" -d '{"s":"site_0000000000000000","u":"https://x.com/"}')
check "unknown site id is rejected" '.error == "unknown_site"' "$UNKNOWN"
CORS=$(curl -sS -o /dev/null -w '%{http_code} %header{access-control-allow-origin}' -X OPTIONS "$BASE/e")
check "/e answers CORS preflight" '. == "204 *"' "\"$CORS\""

echo "- server events"
SRV=$(api POST "/v1/sites/$SITE/events" "{\"events\":[
  {\"name\":\"purchase\",\"url\":\"$U/checkout\",\"ip\":\"10.0.0.1\",\"user_agent\":\"$UA\",\"revenue\":{\"amount\":99,\"currency\":\"USD\"},\"props\":{\"order_id\":\"A-1\"}},
  {\"name\":\"purchase\",\"user_id\":\"u_jp_1\",\"country\":\"JP\",\"city\":\"Tokyo\",\"continent\":\"AS\",\"revenue\":{\"amount\":10,\"currency\":\"USD\"}},
  {\"name\":\"purchase\",\"timestamp\":1000}
]}")
check "server batch: 2 accepted, 1 rejected (old timestamp)" '.accepted == 2 and .rejected == 1 and .results[2].ok == false' "$SRV"
V1=$(collect 10.0.0.1 DE Berlin EU "{\"s\":\"$SITE\",\"n\":\"noop_check\",\"u\":\"$U/pricing\"}" | jq -r .v)
check "server event with ip+ua joins the browser visitor" ".results[0].visitor_id == \"$V1\"" "$SRV"
# that extra noop_check event is part of the expected totals below (V1 custom event)

echo "- goals (retroactive)"
G1=$(api POST "/v1/sites/$SITE/goals" '{"name":"Signup","type":"event","match":"signup"}')
check "create event goal" '.goal.type == "event" and .existing == false' "$G1"
G2=$(api POST "/v1/sites/$SITE/goals" '{"name":"Purchase","type":"event","match":"purchase"}')
check "create second goal" '.goal.name == "Purchase"' "$G2"
G3=$(api POST "/v1/sites/$SITE/goals" '{"name":"Purchase","type":"event","match":"purchase"}')
check "create goal is idempotent by name" '.existing == true' "$G3"
GL=$(api GET "/v1/sites/$SITE/goals")
check "list goals" '.goals | length == 2' "$GL"

echo "- stats"
# 6 visitors (V1-V5 + JP server visitor); 7 pageviews; 12 events (7 pv + signup + noop_check + 3 purchases)
S=$(api GET "/v1/sites/$SITE/stats?period=24h&compare=previous")
check "visitors = 6" '.metrics.visitors == 6' "$S"
check "pageviews = 7" '.metrics.pageviews == 7' "$S"
check "events = 12" '.metrics.events == 12' "$S"
check "conversions = 4 (1 signup + 3 purchases)" '.metrics.conversions == 4' "$S"
check "conversion_rate = 50% (3 of 6 visitors)" '.metrics.conversion_rate == 50' "$S"
check "revenue = 158" '.metrics.revenue == 158' "$S"
check "visit_duration > 0 (engagement counted)" '.metrics.visit_duration > 0' "$S"
check "compare=previous returns a comparison" '.comparison.metrics.visitors == 0 and (.comparison.change_percent | has("visitors"))' "$S"
C=$(api GET "/v1/sites/$SITE/stats?period=24h&breakdown=country&metrics=visitors,pageviews")
check "country breakdown: US 2, DE/IN/FR/JP 1" '([.breakdown.results[] | {(.value): .visitors}] | add) == {"US":2,"DE":1,"IN":1,"FR":1,"JP":1}' "$C"
CH=$(api GET "/v1/sites/$SITE/stats?period=24h&breakdown=channel&metrics=visitors")
check "channel breakdown incl. AI Assistants" '([.breakdown.results[] | {(.value): .visitors}] | add) == {"Direct":2,"Organic Search":1,"AI Assistants":1,"Paid Search":1,"Organic Social":1}' "$CH"
SRC=$(api GET "/v1/sites/$SITE/breakdown?period=24h&breakdown=source&metrics=visitors")
check "source breakdown names ChatGPT and Google" '[.results[].value] | (index("ChatGPT") != null and index("Google") != null)' "$SRC"
GB=$(api GET "/v1/sites/$SITE/breakdown?period=24h&breakdown=goal")
check "goal breakdown: Purchase 3 conversions / 158 revenue, Signup 1" '([.results[] | {(.value): [.conversions, .revenue]}] | add) == {"Purchase":[3,158],"Signup":[1,0]}' "$GB"
F=$(api GET "/v1/sites/$SITE/stats?period=24h&filters=country==US&metrics=visitors,pageviews")
check "filter country==US" '.metrics.visitors == 2 and .metrics.pageviews == 3' "$F"
F2=$(api GET "/v1/sites/$SITE/stats?period=24h&filters=goal==Purchase&breakdown=channel&metrics=visitors")
check "filter goal==Purchase by channel" '.metrics.visitors == 3 and ([.breakdown.results[].value] | sort) == ["AI Assistants","Direct","Organic Search"]' "$F2"
F3=$(api GET "/v1/sites/$SITE/stats?period=24h&filters=page~/blog;channel!=Paid%20Search&metrics=visitors")
check "filter page~/blog;channel!=Paid Search" '.metrics.visitors == 1' "$F3"
P=$(api GET "/v1/sites/$SITE/stats?period=24h&breakdown=prop:plan&filters=event_name==signup&metrics=visitors,events")
check "prop:plan breakdown" '.breakdown.results[0].value == "pro" and .breakdown.results[0].events == 1' "$P"
EP=$(api GET "/v1/sites/$SITE/breakdown?period=24h&breakdown=entry_page&metrics=visitors,bounce_rate")
check "entry_page breakdown" '[.results[].value] | index("/") != null' "$EP"
ERR=$(api GET "/v1/sites/$SITE/stats?filters=nope==1")
check "bad filter -> 400 with hint" '.error.code == "bad_request" and (.error.hint | length > 0)' "$ERR"

echo "- timeseries, realtime, funnel, sql"
TS=$(api GET "/v1/sites/$SITE/timeseries?period=24h&metrics=visitors,pageviews")
check "timeseries: 24 hourly buckets, pageviews sum to 7" '.interval == "hour" and (.results | length) == 24 and ([.results[].pageviews] | add) == 7' "$TS"
TSD=$(api GET "/v1/sites/$SITE/timeseries?period=7d&interval=day")
check "timeseries: 7 daily buckets" '(.results | length) == 7 and ([.results[].visitors] | add) == 6' "$TSD"
RT=$(api GET "/v1/sites/$SITE/realtime")
check "realtime: 6 visitors in 5 min, 12 recent events" '.visitors_last_5m == 6 and (.recent_events | length) == 12' "$RT"
check "realtime: enriched recent events (city, channel)" '[.recent_events[] | select(.city == "Berlin")] | length > 0' "$RT"
FU=$(api GET "/v1/sites/$SITE/funnel?period=24h&steps=/pricing,event:signup")
check "funnel /pricing -> signup: 3 -> 1" '.steps[0].visitors == 3 and .steps[1].visitors == 1 and .steps[1].conversion_rate == 33.3' "$FU"
FG=$(api GET "/v1/sites/$SITE/funnel?period=24h&steps=/,/pricing,goal:Purchase")
check "funnel / -> /pricing -> goal:Purchase" '.steps[0].visitors == 3 and .steps[1].visitors == 2 and .steps[2].visitors == 2' "$FG"
SQL=$(curl -sS -G "$BASE/v1/sites/$SITE/sql" -H "Authorization: Bearer $KEY" --data-urlencode "q=SELECT country, COUNT(DISTINCT visitor_id) AS v FROM events GROUP BY country ORDER BY v DESC, country")
check "sql: SELECT works" '.rows[0].country == "US" and .rows[0].v == 2 and (.columns | index("v") != null)' "$SQL"
SQLW=$(curl -sS -G "$BASE/v1/sites/$SITE/sql" -H "Authorization: Bearer $KEY" --data-urlencode "q=DELETE FROM events")
check "sql: writes are rejected" '.error.code == "sql_rejected"' "$SQLW"
SQLM=$(curl -sS -G "$BASE/v1/sites/$SITE/sql" -H "Authorization: Bearer $KEY" --data-urlencode "q=SELECT 1; DROP TABLE events")
check "sql: multiple statements are rejected" '.error.code == "sql_rejected"' "$SQLM"
sqlq() { curl -sS -G "$BASE/v1/sites/$SITE/sql" -H "Authorization: Bearer $KEY" --data-urlencode "q=$1"; }
check "sql: recursive CTE (no RECURSIVE keyword) is rejected" '.error.code == "sql_rejected"' "$(sqlq 'WITH x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT COUNT(*) FROM x')"
check "sql: WITH RECURSIVE is rejected" '.error.code == "sql_rejected"' "$(sqlq 'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT COUNT(*) FROM x')"
check "sql: comma join is rejected" '.error.code == "sql_rejected"' "$(sqlq 'SELECT COUNT(*) FROM events a, events b, events c')"
check "sql: JOIN without ON is rejected" '.error.code == "sql_rejected"' "$(sqlq 'SELECT COUNT(*) FROM events a JOIN events b')"
check "sql: 3 JOINs are rejected" '.error.code == "sql_rejected"' "$(sqlq 'SELECT 1 FROM events a JOIN events b ON 1 JOIN events c ON 1 JOIN events d ON 1')"
check "sql: a JOIN with ON still runs" '.rows[0].n == 12' "$(sqlq 'SELECT COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id')"

echo "- verify, share, keys"
VER=$(api POST "/v1/sites/$SITE/verify" "{\"url\":\"$BASE/llms.txt\"}")
check "verify reports events received + snippet fix" '.receiving_events == true and (.checks | map(.id) | index("snippet_present") != null) and (.fixes | length > 0)' "$VER"
SH=$(api POST "/v1/sites/$SITE/share" '{}')
TOKEN=$(printf '%s' "$SH" | jq -r .token)
check "share link created" '.url | contains("/share/shr_")' "$SH"
HTML=$(curl -sS "$BASE/share/$TOKEN")
check "share page is HTML" '. == true' "$(printf '%s' "$HTML" | grep -q '<svg id="chart"' && echo true || echo false)"
SD=$(curl -sS "$BASE/share/$TOKEN/data?period=7d")
check "share data: visitors 6, top countries" '.metrics.visitors == 6 and (.top_countries | length) == 5' "$SD"
RK=$(api POST /v1/keys '{"name":"ro","scope":"read"}' | jq -r .api_key)
RO=$(curl -sS -X POST "$BASE/v1/sites" -H "Authorization: Bearer $RK" -d '{"domain":"ro.example.com"}')
check "read key cannot create sites" '.error.code == "forbidden"' "$RO"
ROV=$(curl -sS -X POST "$BASE/v1/sites/$SITE/verify" -H "Authorization: Bearer $RK" -d '{}')
check "read key cannot run verify" '.error.code == "forbidden"' "$ROV"
ROS=$(curl -sS "$BASE/v1/sites/$SITE/stats?period=24h&metrics=visitors" -H "Authorization: Bearer $RK")
check "read key can read stats" '.metrics.visitors == 6' "$ROS"

echo "- MCP"
mcp() { curl -sS "$BASE/mcp" -H "Authorization: Bearer ${2:-$KEY}" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d "$1"; }
TL=$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
check "tools/list has every tool" '[.result.tools[].name] as $n | ["create_site","list_sites","get_site","update_site","delete_site","get_install_instructions","verify_install","get_stats","get_timeseries","get_breakdown","get_realtime","get_funnel","track_events","create_goal","list_goals","delete_goal","query_sql","create_share_link"] | all(. as $t | $n | index($t) != null)' "$TL"
TLR=$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$RK")
check "read key sees no write tools (verify_install included)" '[.result.tools[].name] | (index("get_stats") != null and index("create_site") == null and index("verify_install") == null)' "$TLR"
TC=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_stats\",\"arguments\":{\"site_id\":\"$SITE\",\"period\":\"24h\",\"metrics\":[\"visitors\",\"revenue\"],\"breakdown\":\"country\"}}}")
check "tools/call get_stats" '(.result.content[0].text | fromjson) as $s | $s.metrics.visitors == 6 and $s.metrics.revenue == 158 and ($s.breakdown.results | length) == 5' "$TC"
TE=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_funnel\",\"arguments\":{\"site_id\":\"$SITE\",\"period\":\"24h\",\"steps\":[\"/pricing\",\"goal:Nope\"]}}}")
check "tool errors carry a hint" '.result.isError == true and ((.result.content[0].text | fromjson).error.hint | length > 0)' "$TE"

echo "- forwarded headers need the proxy key; /e body cap"
S2_JSON=$(api POST /v1/sites "{\"domain\":\"trust-$RANDOM$RANDOM.example.com\"}")
S2=$(printf '%s' "$S2_JSON" | jq -r .site.id)
PK2=$(printf '%s' "$S2_JSON" | jq -r .install.first_party_proxy.proxy_key)
U2="https://$(printf '%s' "$S2_JSON" | jq -r .site.domain)"
fwd() { # fwd PATH IP [PROXY_KEY]: spoof-style headers, with or without the site's key
  curl -sS -X POST "$BASE$1" -A "$UA" -H "x-forwarded-for: $2" -H "x-afs-geo-country: JP" -H "x-afs-geo-city: Tokyo" \
    ${3:+-H "x-afs-proxy-key: $3"} -d "{\"s\":\"$S2\",\"u\":\"$U2/\"}"
}
A=$(fwd /e 192.0.2.10); B=$(fwd /e 192.0.2.20 "$(printf '0%.0s' {1..64})")
check "without a valid key, X-Forwarded-For is ignored (two IPs, one visitor)" ".ok == true and .v == $(printf '%s' "$B" | jq .v)" "$A"
C=$(fwd /_a/e 192.0.2.30 "$PK2"); D=$(fwd /_a/e 192.0.2.40 "$PK2")
check "with the proxy key, X-Forwarded-For counts (two IPs, two visitors)" ".ok == true and .v != $(printf '%s' "$D" | jq .v) and .v != $(printf '%s' "$A" | jq .v)" "$C"
GEO=$(curl -sS -G "$BASE/v1/sites/$S2/sql" -H "Authorization: Bearer $KEY" --data-urlencode "q=SELECT SUM(country = 'JP' AND city = 'Tokyo') AS jp, COUNT(*) AS n FROM events")
check "x-afs-geo-* is used only with the key (2 of 4 events in JP)" '.rows[0].jp == 2 and .rows[0].n == 4' "$GEO"
fwd /_a/e 192.0.2.50 >/dev/null
W=$(api GET "/v1/sites/$S2")
check "a proxied event without the key is kept and counted as a proxy_key_missing warning" '.data.warnings_last_7d.proxy_key_missing.count == 1 and .data.total_events == 5' "$W"
BIG=$(head -c 17000 /dev/zero | tr '\0' 'a')
TOO=$(curl -sS -w ' %{http_code}' -X POST "$BASE/e" -A "$UA" -d "{\"s\":\"$S2\",\"u\":\"$U2/\",\"p\":{\"x\":\"$BIG\"}}")
check "/e refuses a body over 16 KB" '. == true' "$(printf '%s' "$TOO" | grep -q '"payload_too_large".* 413$' && echo true || echo false)"
TOOC=$(head -c 20000 /dev/zero | tr '\0' 'a' | curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/e" -A "$UA" -H "transfer-encoding: chunked" --data-binary @-)
check "/e refuses a chunked body over 16 KB (no content-length)" '. == "413"' "\"$TOOC\""
api DELETE "/v1/sites/$S2" >/dev/null

echo "- cleanup"
DEL=$(api DELETE "/v1/sites/$SITE")
check "delete site" ".deleted == \"$SITE\"" "$DEL"
GONE=$(api GET "/v1/sites/$SITE/stats")
check "deleted site is gone" '.error.code == "not_found"' "$GONE"

echo
echo "smoke: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
