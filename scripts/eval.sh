#!/usr/bin/env bash
# Run a batch of quiet simulations at once, wait, then print every conversation
# with automatic flags. Usage: scripts/eval.sh [turns] [types...]
#   scripts/eval.sh 10 shy horny cheap whale burst
set -euo pipefail
cd "$(dirname "$0")/.."
TURNS="${1:-10}"; shift || true
TYPES=("${@:-shy horny cheap whale burst}")
read -ra TYPES <<< "${TYPES[*]}"
START=$(($(date +%s) * 1000))
for t in "${TYPES[@]}"; do
  scripts/admin.sh simulate-turns "$t" "$TURNS" >/dev/null
  echo "started $t"
done
db() { npx wrangler d1 execute DB --remote --json --command "$1" 2>/dev/null; }
# Done when every sim fan has TURNS messages and the last message is hers, or after 25 minutes.
for i in $(seq 1 100); do
  done=$(db "SELECT COUNT(*) AS n FROM fans f WHERE f.source='sim' AND f.created_at >= $START
    AND (SELECT COUNT(*) FROM messages m WHERE m.fan_id=f.fan_id AND m.role='fan') >= $TURNS
    AND (SELECT role FROM messages m WHERE m.fan_id=f.fan_id ORDER BY id DESC LIMIT 1) = 'her'" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['results'][0]['n'])" || echo 0)
  echo "$(date +%T) finished: $done/${#TYPES[@]}"
  [ "$done" -ge "${#TYPES[@]}" ] && sleep 20 && break
  sleep 15
done
db "SELECT fan_id, price_cents, status FROM sales WHERE fan_id IN (SELECT fan_id FROM fans WHERE source='sim' AND created_at >= $START)" \
  | python3 -c '
import json, sys
rows = json.load(sys.stdin)[0]["results"]
print("== SALES:", len(rows), "offered,", sum(r["status"] == "bought" for r in rows), "bought, $%.2f" % (sum(r["price_cents"] for r in rows if r["status"] == "bought") / 100))
'
db "SELECT f.fan_id, f.profile, m.role, m.text FROM fans f JOIN messages m ON m.fan_id = f.fan_id
    WHERE f.source='sim' AND f.created_at >= $START ORDER BY f.fan_id, m.id" | python3 -c '
import json, re, sys
rows = json.load(sys.stdin)[0]["results"]
FLAGS = {
  "out of character": r"\b(ai|a\.i\.|bot|robot|creator|programmed|language model|virtual)\b",
  "claims she sent something": r"\b(sent (you|it|them)|here (you go|it is)|check (your|ur) (inbox|dms)|just sent)\b",
  "too long": r"^.{220,}$",
  "tip for photos": r"\btip\b.*\b(show|send|pic|photo)|\b(show|send|pic|photo)\b.*\btip\b",
}
convos = {}
for r in rows: convos.setdefault(r["fan_id"], {"profile": r["profile"], "msgs": []})["msgs"].append(r)
total = {k: 0 for k in FLAGS}
for fid, c in convos.items():
  print("\n==========", fid.split(":")[1].upper(), "==========")
  seen = set()
  for m in c["msgs"]:
    tag = []
    if m["role"] == "her":
      for k, rx in FLAGS.items():
        if re.search(rx, re.sub(r"\[[^\]]*\]", "", m["text"]), re.I): tag.append(k); total[k] += 1
      if m["text"] in seen: tag.append("repeated"); 
      seen.add(m["text"])
    print(("👤 " if m["role"] == "fan" else "💋 ") + m["text"] + (f"   ⚠️ {", ".join(tag)}" if tag else ""))
  print("-- remembered:", c["profile"])
print("\n== FLAGS TOTAL:", total)
'
