#!/bin/bash
# Translation E2E runner: dev server (with LIBRETRANSLATE_URL pointed at the
# in-process mock) up → tests → down. Single process-tree lifetime.
set -uo pipefail
cd /home/z/my-project
PORT=3102
LOG=/tmp/translate-dev.log
rm -f "${LOG}"

# .env for this run: SQLite + mock LibreTranslate (mock runs inside the test
# process itself, so its port only needs to be reachable from the dev server).
cp .env /tmp/env.backup.translation
printf 'LIBRETRANSLATE_URL="http://localhost:5001"\n' >> .env

bunx next dev -p "${PORT}" > "${LOG}" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 60); do
  curl -s -o /dev/null "http://localhost:${PORT}/api/health" 2>/dev/null && break
  sleep 1
done

DATABASE_URL=file:/home/z/my-project/db/custom.db DATABASE_PROVIDER=sqlite \
  BASE_URL="http://localhost:${PORT}" bun scripts/test-translation-e2e.ts
TEST_EXIT=$?

kill "${SERVER_PID}" 2>/dev/null; pkill -f "next dev -p ${PORT}" 2>/dev/null; sleep 1
mv /tmp/env.backup.translation .env

# Part 2: in-process LLM provider chain (Groq → DeepSeek → Gemini → LT) —
# mocked fetch, no server needed.
echo "— LLM provider chain (in-process, mocked fetch) —"
bun scripts/test-llm-translation.ts
LLM_EXIT=$?

[ "${TEST_EXIT}" -eq 0 ] && [ "${LLM_EXIT}" -eq 0 ] && exit 0 || exit 1
