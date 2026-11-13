#!/bin/bash
# Metric accuracy test: builds a small, known set of leads and calls, then checks every scorecard number against the answer worked out by hand.
# Run from the repo root:  bash tests/metrics.sh      (needs node, python3 and wrangler via npx; uses port 8897)
cd "$(dirname "$0")/.." || exit 1
D=$(mktemp -d); PORT=8897; export D PORT
pkill -f "port $PORT" 2>/dev/null; sleep 1
(npx wrangler dev --local --port $PORT --persist-to "$D/state" --var TWILIO_TOKEN:tok --var PASSWORD_BRONSON:pw --var CRM_HOST:localhost --var TWILIO_FROM:+13055550000 --var CALL_FORWARD_TO:+13055557777 > "$D/wrangler.log" 2>&1 &)
for i in $(seq 1 40); do curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
curl -s --noproxy '*' -c "$D/cj" -H 'Host: localhost' -d 'username=bronson&password=pw' "http://127.0.0.1:$PORT/login" -o /dev/null
curl -s --noproxy '*' -b "$D/cj" -H 'Host: localhost' "http://127.0.0.1:$PORT/admin/today" -o /dev/null
node tests/metrics.mjs; RC=$?
pkill -f "port $PORT" 2>/dev/null; pkill -f workerd 2>/dev/null
exit $RC
