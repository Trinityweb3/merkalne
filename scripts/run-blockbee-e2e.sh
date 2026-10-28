#!/usr/bin/env bash
# BlockBee e2e runner: fresh sqlite DB → dev server (blockbee mode, mock
# processor on :3199) → tests → down.
set -uo pipefail
cd /home/z/my-project
PORT=3103
LOG=/tmp/blockbee-dev.log
DB=/tmp/blockbee-e2e.db

rm -f "${LOG}" "${DB}"

# .env for this run: fresh sqlite + BlockBee pointed at the in-test mock
# processor. ADS_TOPUP_MODE is left EMPTY on purpose — the auto-resolution
# (blockbee because BLOCKBEE_API_KEY is set) is part of what is tested.
cp .env /tmp/env.backup.blockbee
cat > .env <<EOF
DATABASE_URL="file:${DB}"
DATABASE_PROVIDER="sqlite"
APP_URL="http://localhost:${PORT}"
ADS_TOPUP_MODE=""
AUTH_SECRET="blockbee-e2e-test-secret-0123456789abcdef"
BLOCKBEE_API_KEY="test-blockbee-key"
BLOCKBEE_IPN_SECRET="test-blockbee-ipn-secret-0123456789abcdef"
BLOCKBEE_MIN_PAYOUT_CENTS="2000"
BLOCKBEE_API_BASE="http://127.0.0.1:3199"
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

BASE_URL="http://localhost:${PORT}" bun scripts/test-blockbee-e2e.ts
TEST_EXIT=$?

kill "${SERVER_PID}" 2>/dev/null; pkill -f "next dev -p ${PORT}" 2>/dev/null; sleep 1
mv /tmp/env.backup.blockbee .env
rm -f "${DB}"

exit "${TEST_EXIT}"
