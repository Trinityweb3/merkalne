#!/usr/bin/env bash
# Ads events e2e runner (Phase 3): fresh sqlite DB → dev server (simulate
# mode) on :3104 → tests → down.
#
# Covers the whole Phase 3 event pipeline end-to-end, including a REAL
# Chromium pass (Playwright) that measures the viewability delay and follows
# the signed click redirect: bash scripts/run-ads-events-e2e.sh
set -uo pipefail
cd /home/z/my-project
PORT=3104
LOG=/tmp/ads-events-dev.log
DB=/tmp/ads-events-e2e.db

rm -f "${LOG}" "${DB}"

# .env for this run: fresh sqlite + simulate top-ups. A shared AUTH_SECRET
# matters here: the tests craft HMAC ad tokens white-box (same secret as the
# server) to exercise the expired-token paths without waiting 30 minutes.
cp .env /tmp/env.backup.ads-events
cat > .env <<EOF
DATABASE_URL="file:${DB}"
DATABASE_PROVIDER="sqlite"
APP_URL="http://localhost:${PORT}"
ADS_TOPUP_MODE="simulate"
AUTH_SECRET="ads-events-e2e-secret-0123456789abcdef"
TELEGRAM_ADMIN_WEBHOOK_SECRET="test_admin_secret_0123456789ab"
TELEGRAM_ADMIN_USER_IDS="999000222"
EOF

# Push the schema into the fresh DB.
export DATABASE_URL="file:${DB}"
export DATABASE_PROVIDER="sqlite"
bunx prisma db push --schema prisma/schema.sqlite.prisma --accept-data-loss --skip-generate > /dev/null 2>&1

bunx next dev -p "${PORT}" > "${LOG}" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 90); do
  curl -s -o /dev/null "http://localhost:${PORT}/api/health" 2>/dev/null && break
  sleep 1
done

BASE_URL="http://localhost:${PORT}" bun scripts/test-ads-events-e2e.ts
TEST_EXIT=$?

kill "${SERVER_PID}" 2>/dev/null; pkill -f "next dev -p ${PORT}" 2>/dev/null; sleep 1
mv /tmp/env.backup.ads-events .env
rm -f "${DB}"

exit "${TEST_EXIT}"
