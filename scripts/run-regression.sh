#!/bin/bash
# Regression-check runner: dev server up → notifier + translation checks → down.
set -uo pipefail
cd /home/z/my-project
PORT=3101
LOG=/tmp/regression-dev.log
rm -f "${LOG}"
bunx next dev -p "${PORT}" > "${LOG}" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 60); do
  curl -s -o /dev/null "http://localhost:${PORT}/api/health" 2>/dev/null && break
  sleep 1
done
DATABASE_URL=file:/home/z/my-project/db/custom.db DATABASE_PROVIDER=sqlite \
  BASE_URL="http://localhost:${PORT}" bun scripts/test-post-split-regression.ts
TEST_EXIT=$?
kill "${SERVER_PID}" 2>/dev/null; pkill -f "next dev -p ${PORT}" 2>/dev/null; sleep 1
exit "${TEST_EXIT}"
