#!/bin/sh
# End-to-end smoke: install, test, typecheck, start server, Inspector tools/list + tools/call per tool, stop.
set -eu
cd "$(dirname "$0")/.."

PASS=1
fail() {
  echo "FAIL: $1" >&2
  PASS=0
}

echo "== npm ci =="
npm ci

echo "== npm test =="
npm test

echo "== npm run typecheck =="
npm run typecheck

PORT="${SMOKE_PORT:-3847}"
export PORT
export HOST=127.0.0.1

echo "== start server on $PORT =="
npx tsx src/index.ts > /tmp/dinner-conductor-smoke.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for health
i=0
while [ "$i" -lt 40 ]; do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 0.25
done
if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  fail "server did not become healthy"
  cat /tmp/dinner-conductor-smoke.log >&2 || true
  echo FAIL
  exit 1
fi

URL="http://127.0.0.1:${PORT}/mcp"
INSPECTOR="npx @modelcontextprotocol/inspector --cli --transport http --server-url ${URL} --format json"

echo "== Inspector tools/list =="
LIST_OUT=$($INSPECTOR --method tools/list 2>/dev/null || true)
for name in find_dish plan_meal whats_next running_late change_menu read_plan resume_plan; do
  echo "$LIST_OUT" | grep -q "\"name\":\"$name\"" || fail "tools/list missing $name"
done

echo "== Inspector tools/call find_dish =="
FIND_OUT=$($INSPECTOR --method tools/call --tool-name find_dish --tool-arg name=rice 2>/dev/null || true)
echo "$FIND_OUT" | grep -q "summary" || fail "find_dish missing summary"

echo "== Inspector tools/call plan_meal =="
PLAN_OUT=$($INSPECTOR --method tools/call --tool-name plan_meal \
  --tool-args-json '{"dishes":["chicken_thighs","roast_potatoes","green_beans"],"serve_at":"18:00","timezone":"America/New_York","ovens":1,"cooks":1}' \
  2>/dev/null || true)
echo "$PLAN_OUT" | grep -q "plan_id" || fail "plan_meal missing plan_id"
PLAN_ID=$(printf '%s' "$PLAN_OUT" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  try {
    const msg=JSON.parse(s);
    const sc=msg.result&&msg.result.structuredContent;
    if (sc&&sc.plan_id) { console.log(sc.plan_id); return; }
    const t=msg.result&&msg.result.content&&msg.result.content[0]&&msg.result.content[0].text;
    if (t) { const p=JSON.parse(t); if (p.plan_id) { console.log(p.plan_id); return; } }
  } catch {}
});')
PLAN_TOKEN=$(printf '%s' "$PLAN_OUT" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  try {
    const msg=JSON.parse(s);
    const sc=msg.result&&msg.result.structuredContent;
    if (sc&&sc.plan_token) { console.log(sc.plan_token); return; }
    const t=msg.result&&msg.result.content&&msg.result.content[0]&&msg.result.content[0].text;
    if (t) { const p=JSON.parse(t); if (p.plan_token) { console.log(p.plan_token); return; } }
  } catch {}
});')
if [ -z "$PLAN_ID" ]; then
  fail "could not parse plan_id"
  PLAN_ID=missing
fi
if [ -z "$PLAN_TOKEN" ]; then
  fail "could not parse plan_token"
  PLAN_TOKEN=missing
fi

echo "== Inspector tools/call whats_next =="
$INSPECTOR --method tools/call --tool-name whats_next \
  --tool-arg "plan_id=${PLAN_ID}" --tool-arg now=17:00 \
  2>/dev/null | grep -q "summary" || fail "whats_next missing summary"

echo "== Inspector tools/call read_plan =="
$INSPECTOR --method tools/call --tool-name read_plan \
  --tool-arg "plan_id=${PLAN_ID}" \
  2>/dev/null | grep -q "card" || fail "read_plan missing card"

echo "== Inspector tools/call running_late =="
$INSPECTOR --method tools/call --tool-name running_late \
  --tool-args-json "{\"plan_id\":\"${PLAN_ID}\",\"dish\":\"roast_potatoes\",\"minutes\":5}" \
  2>/dev/null | grep -q "summary" || fail "running_late missing summary"

echo "== Inspector tools/call change_menu =="
$INSPECTOR --method tools/call --tool-name change_menu \
  --tool-args-json "{\"plan_id\":\"${PLAN_ID}\",\"add\":[\"salad\"]}" \
  2>/dev/null | grep -q "summary" || fail "change_menu missing summary"

echo "== Inspector tools/call resume_plan =="
$INSPECTOR --method tools/call --tool-name resume_plan \
  --tool-arg "plan_token=${PLAN_TOKEN}" \
  2>/dev/null | grep -q "plan_id" || fail "resume_plan missing plan_id"

echo "== /sim page =="
curl -sf "http://127.0.0.1:${PORT}/sim" | grep -q "Simulated Alexa+ page" || fail "/sim banner missing"

if [ "$PASS" -eq 1 ]; then
  echo PASS
  exit 0
fi
echo FAIL
exit 1
