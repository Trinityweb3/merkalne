#!/bin/bash
# ---------------------------------------------------------------------------
# Admin-bot E2E runner: starts a dedicated dev server, waits for readiness,
# runs the wizard test suite, then shuts the server down. All in ONE process
# tree lifetime so the sandbox reaper cannot kill the server mid-test.
# ---------------------------------------------------------------------------
set -uo pipefail
cd /home/z/my-project

PORT=3100
LOG=/tmp/admin-bot-dev.log

# .env for this run: the webhook secret + admin id the test suite uses
# (self-contained — does not depend on the developer's local .env).
cp .env /tmp/env.backup.admin-bot
printf 'TELEGRAM_ADMIN_WEBHOOK_SECRET="test_admin_secret_0123456789ab"\nTELEGRAM_ADMIN_USER_IDS="999000111"\n' >> .env

echo "[runner] starting dev server on :${PORT}…"
rm -f "${LOG}" dev.log
bunx next dev -p "${PORT}" > "${LOG}" 2>&1 &
SERVER_PID=$!

# Wait for readiness (max 60s)
for i in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:${PORT}/api/health" 2>/dev/null; then
    echo "[runner] server ready after ${i}s"
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "[runner] server died during boot:"; tail -20 "${LOG}"; exit 1
  fi
  sleep 1
done

curl -s -o /dev/null "http://localhost:${PORT}/api/health" || { echo "[runner] server never became ready"; tail -30 "${LOG}"; kill "${SERVER_PID}"; exit 1; }

echo "[runner] running E2E suite…"
DATABASE_URL=file:/home/z/my-project/db/custom.db DATABASE_PROVIDER=sqlite \
  BASE_URL="http://localhost:${PORT}" bun scripts/test-admin-bot-e2e.ts
TEST_EXIT=$?

echo "[runner] stopping dev server…"
kill "${SERVER_PID}" 2>/dev/null
pkill -f "next dev -p ${PORT}" 2>/dev/null
sleep 1
mv /tmp/env.backup.admin-bot .env

echo "[runner] test exit: ${TEST_EXIT}"
exit "${TEST_EXIT}"
