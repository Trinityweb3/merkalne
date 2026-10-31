#!/usr/bin/env bash
# Ads e2e runner: fresh sqlite DB → dev server (simulate mode) → tests → down.
set -uo pipefail
cd /home/z/my-project
PORT=3103
LOG=/tmp/ads-dev.log
DB=/tmp/ads-e2e.db

rm -f "${LOG}" "${DB}"

# .env for this run: fresh sqlite + simulate top-ups so the advertiser can
# self-confirm (the production default is manual/admin confirmation).
# The admin-bot webhook secret + admin id list let the moderation section
# drive the REAL telegram-admin route (console-fallback replies — no bot
# token, mirroring run-admin-bot-e2e.sh).
cp .env /tmp/env.backup.ads
cat > .env <<EOF
DATABASE_URL="file:${DB}"
DATABASE_PROVIDER="sqlite"
APP_URL="http://localhost:${PORT}"
ADS_TOPUP_MODE="simulate"
AUTH_SECRET="ads-e2e-test-secret-0123456789abcdef"
TELEGRAM_ADMIN_WEBHOOK_SECRET="test_admin_secret_0123456789ab"
TELEGRAM_ADMIN_USER_IDS="999000111"
EOF

# Push the schema into the fresh DB. (Explicit export: an inherited shell
# DATABASE_URL would override the .env we just wrote.)
export DATABASE_URL="file:${DB}"
export DATABASE_PROVIDER="sqlite"
bunx prisma db push --schema prisma/schema.sqlite.prisma --accept-data-loss --skip-generate > /dev/null 2>&1

bunx next dev -p "${PORT}" > "${LOG}" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 90); do
  curl -s -o /dev/null "http://localhost:${PORT}/api/health" 2>/dev/null && break
  sleep 1
done

BASE_URL="http://localhost:${PORT}" bun scripts/test-ads-e2e.ts
TEST_EXIT=$?

kill "${SERVER_PID}" 2>/dev/null; pkill -f "next dev -p ${PORT}" 2>/dev/null; sleep 1
mv /tmp/env.backup.ads .env
rm -f "${DB}"

exit "${TEST_EXIT}"
