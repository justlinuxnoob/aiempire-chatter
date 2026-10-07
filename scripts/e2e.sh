#!/usr/bin/env bash
# Full local end-to-end test: fresh local DB, fake Telegram/RunPod/Fanvue, wrangler dev, then test/e2e/run.mjs.
# Needs .dev.vars with the fake values listed at the top of test/e2e/run.mjs.
set -uo pipefail
cd "$(dirname "$0")/.."
LOGS="${E2E_LOGS:-/tmp}"
stop() { pkill -f "[m]ock-server.mjs"; pkill -f "[w]orkerd serve"; pkill -f "node_modules/.bin/[w]rangler"; sleep 1; }
stop
rm -rf .wrangler/state
npx wrangler d1 migrations apply DB --local >/dev/null 2>&1
node test/e2e/mock-server.mjs > "$LOGS/mock.log" 2>&1 &
npx wrangler dev --port 8787 --ip 127.0.0.1 --test-scheduled > "$LOGS/dev.log" 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8787/ && break; sleep 1; done
node test/e2e/run.mjs
code=$?
stop
exit $code
