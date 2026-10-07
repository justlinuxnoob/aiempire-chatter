#!/usr/bin/env bash
# Test helpers (need ADMIN_KEY in secrets.env, which is never committed).
#   scripts/admin.sh simulate shy        start a simulation (output in your Telegram)
#   scripts/admin.sh say "hey u up?"     text her as your test fan
#   scripts/admin.sh transcript [fan]    print the latest simulation (or a fan id's) conversation
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${WORKER_URL:-https://aiempire-chatter.tvpoletv.workers.dev}"
KEY=$(grep '^ADMIN_KEY=' secrets.env | cut -d= -f2-)
post() { curl -sS -X POST "$URL/admin/$1" -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d "$2"; echo; }
case "${1:-}" in
  simulate) post simulate "$(python3 -c 'import json,sys; print(json.dumps({"type": sys.argv[1]}))' "$2")" ;;
  connect) post fanvue-connect-link "{}" ;;
  testcode) post test-code "{}" ;;
  webhook) post fanvue-webhook "{}" ;;
  fv) post fanvue-raw "$2" ;;
  simulate-turns) post simulate "$(python3 -c 'import json,sys; print(json.dumps({"type": sys.argv[1], "turns": int(sys.argv[2])}))' "$2" "$3")" ;;
  say) post fan-message "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$2")" ;;
  transcript)
    FAN="${2:-}"
    if [ -z "$FAN" ]; then
      FAN=$(npx wrangler d1 execute DB --remote --json --command "SELECT fan_id FROM fans WHERE source='sim' ORDER BY created_at DESC LIMIT 1" 2>/dev/null | python3 -c "import json,sys; r=json.load(sys.stdin)[0]['results']; print(r[0]['fan_id'] if r else '')")
    fi
    echo "== $FAN"
    npx wrangler d1 execute DB --remote --json --command "SELECT role, text FROM messages WHERE fan_id = '$FAN' ORDER BY id; SELECT profile FROM fans WHERE fan_id = '$FAN'; SELECT kind, detail FROM alerts WHERE fan_id = '$FAN' ORDER BY id" 2>/dev/null \
      | python3 -c "
import json,sys
msgs, prof, alerts = [x['results'] for x in json.load(sys.stdin)]
for m in msgs: print(('👤 ' if m['role']=='fan' else '💋 ') + m['text'])
print('-- remembered:', prof[0]['profile'] if prof else '{}')
for a in alerts: print('-- alert:', a['kind'], '|', a['detail'])" ;;
  *) sed -n 2,6p "$0" ;;
esac
