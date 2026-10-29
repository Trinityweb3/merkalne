#!/usr/bin/env bash
# Premium e2e runner: fresh sqlite DB → dev server (BlockBee mock on :3198,
# Telegram notifier webhook secret set, NO bot token → console-fallback
# replies) → tests → down.
set -uo pipefail
cd /home/z/my-project
PORT=3104
LOG=/tmp/premium-dev.log
DB=/tmp/premium-e2e.db

rm -f "${LOG}" "${DB}"

# .env for this run: fresh sqlite, BlockBee pointed at the in-test mock
# processor, and the Telegram notifier webhook secured with the secret the
# suite uses. TELEGRAM_BOT_TOKEN stays unset so bot replies fall back to the
# console (the same honest-dev fallback the admin-bot e2e relies on).
cp .env /tmp/env.backup.premium
cat > .env <<EOF
DATABASE_URL="file:${DB}"
DATABASE_PROVIDER="sqlite"
APP_URL="http://localhost:${PORT}"
AUTH_SECRET="premium-e2e-test-secret-0123456789abcdef"
BLOCKBEE_API_KEY="test-premium-blockbee-key"
BLOCKBEE_IPN_SECRET="test-premium-ipn-secret-0123456789abcdef"
BLOCKBEE_API_BASE="http://127.0.0.1:3198"
TELEGRAM_WEBHOOK_SECRET="test-premium-tg-secret-0123456789abcdef"
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

BASE_URL="http://localhost:${PORT}" bun scripts/test-premium-e2e.ts
TEST_EXIT=$?

kill "${SERVER_PID}" 2>/dev/null; pkill -f "next dev -p ${PORT}" 2>/dev/null; sleep 1
mv /tmp/env.backup.premium .env
rm -f "${DB}"

exit "${TEST_EXIT}"
