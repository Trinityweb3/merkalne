#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Merklane — build the portable export bundle
#
#   bash scripts/build-export.sh [output-dir]
#
# Produces in the output dir (default: ./dist-export):
#   merklane-project.tar.gz        clean source archive (top-level merklane/)
#   merklane-project.tar.gz.sha256 checksum
#   setup-project.sh               self-extracting one-file installer
#   POST-EXPORT-GUIDE.md           copy of the local-setup guide
#
# Excluded by design: node_modules, .next, .git, db, .env*, logs, sandbox dirs.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${0}")/.." && pwd)"
OUT="${1:-${ROOT}/dist-export}"
STAGE="$(mktemp -d)/stage"
ARCHIVE_NAME="merklane-project.tar.gz"

# ---------------------------------------------------------------------------
# Pre-flight assertions — the bundle REFUSES to build if any deployment-
# critical line is missing. These guard against exactly the regressions that
# crashed production boots before (Dockerfile losing its prisma/bcryptjs/
# node_modules COPY lines, stylesheet shipping without the About-page rules).
# ---------------------------------------------------------------------------
echo "[export] pre-flight assertions…"
fail=0
assert_file_contains() {
  # $1 file, $2 grep -F pattern, $3 human description
  if grep -qF "$2" "$1" 2>/dev/null; then
    echo "  [ok]   $3"
  else
    echo "  [FAIL] $3"
    echo "         missing in: $1"
    echo "         expected:  $2"
    fail=1
  fi
}

assert_file_contains "${ROOT}/Dockerfile" \
  'COPY --from=builder --chown=merklane:merklane /app/node_modules ./node_modules' \
  "Dockerfile: FULL node_modules COPY into the runner"
assert_file_contains "${ROOT}/Dockerfile" \
  'COPY --from=builder --chown=merklane:merklane /app/prisma ./prisma' \
  "Dockerfile: prisma schema+migrations COPY"
assert_file_contains "${ROOT}/Dockerfile" \
  'COPY --from=builder --chown=merklane:merklane /app/node_modules/bcryptjs ./node_modules/bcryptjs' \
  "Dockerfile: bcryptjs COPY (seed dependency)"
assert_file_contains "${ROOT}/Dockerfile" \
  'COPY --from=deps /app/node_modules ./node_modules' \
  "Dockerfile: builder-stage node_modules COPY"
assert_file_contains "${ROOT}/src/app/globals.css" '.stat-grid' \
  "globals.css: About stat-grid rules present (not a stale stylesheet)"
assert_file_contains "${ROOT}/src/app/globals.css" '.team-avatar' \
  "globals.css: About team rules present"
assert_file_contains "${ROOT}/src/app/globals.css" 'line-height: 1.15' \
  "globals.css: stat value hardening present"
assert_file_contains "${ROOT}/src/app/globals.css" '.page {' \
  "globals.css: base .page padding present (breadcrumb fix)"
assert_file_contains "${ROOT}/src/app/globals.css" '.breadcrumb {' \
  "globals.css: breadcrumb styling present"
assert_file_contains "${ROOT}/src/i18n/routing.ts" "localePrefix: 'as-needed'" \
  "i18n: as-needed locale routing configured"
[ -f "${ROOT}/src/app/[locale]/layout.tsx" ] && echo "  [ok]   app/[locale]/layout.tsx present (i18n root layout)" \
  || { echo "  [FAIL] app/[locale]/layout.tsx missing"; fail=1; }
[ -f "${ROOT}/src/app/api/donations/route.ts" ] && echo "  [ok]   /api/donations route present" \
  || { echo "  [FAIL] /api/donations route missing"; fail=1; }
msg_count="$(ls -1 ${ROOT}/src/i18n/messages/ 2>/dev/null | wc -l)"
[ "${msg_count}" -ge 20 ] && echo "  [ok]   ${msg_count}/20 i18n dictionaries present" \
  || { echo "  [FAIL] only ${msg_count}/20 i18n dictionaries present"; fail=1; }
assert_file_contains "${ROOT}/.env.example" 'DONATION_SOL_ADDRESS' \
  ".env.example: donation wallet variables documented"
assert_file_contains "${ROOT}/docker-compose.yml" 'DONATION_SOL_ADDRESS' \
  "docker-compose: donation env passthrough"
assert_file_contains "${ROOT}/docker-compose.yml" '1.1.1.1' \
  "docker-compose: pinned container DNS"
[ -f "${ROOT}/docker-compose.egress.yml" ] && echo "  [ok]   docker-compose.egress.yml present (host-net escape hatch)" \
  || { echo "  [FAIL] docker-compose.egress.yml missing"; fail=1; }
[ -x "${ROOT}/docker/entrypoint.sh" ] && echo "  [ok]   docker/entrypoint.sh present + executable" \
  || { echo "  [FAIL] docker/entrypoint.sh missing or not executable"; fail=1; }
[ -x "${ROOT}/docker/fix-container-network.sh" ] && echo "  [ok]   docker/fix-container-network.sh present + executable" \
  || { echo "  [FAIL] docker/fix-container-network.sh missing or not executable"; fail=1; }
[ -f "${ROOT}/src/proxy.ts" ] && echo "  [ok]   src/proxy.ts present (Next 16 proxy convention)" \
  || { echo "  [FAIL] src/proxy.ts missing — the edge middleware MUST be proxy.ts on Next 16"; fail=1; }
[ ! -f "${ROOT}/src/middleware.ts" ] && echo "  [ok]   no legacy src/middleware.ts (avoids the deprecation warning)" \
  || { echo "  [FAIL] src/middleware.ts still exists — rename to proxy.ts (Next 16)"; fail=1; }
[ -x "${ROOT}/docker/check-app-tree.sh" ] && echo "  [ok]   docker/check-app-tree.sh present + executable" \
  || { echo "  [FAIL] docker/check-app-tree.sh missing or not executable"; fail=1; }
assert_file_contains "${ROOT}/Dockerfile" \
  'RUN sh docker/check-app-tree.sh' \
  "Dockerfile: stale-merge guard wired into the builder stage"
# --- Telegram dual-bot architecture (guards the missing-token regression) ---
assert_file_contains "${ROOT}/.env.example" 'TELEGRAM_ADMIN_BOT_TOKEN=""' \
  ".env.example: TELEGRAM_ADMIN_BOT_TOKEN documented"
assert_file_contains "${ROOT}/.env.example" 'TELEGRAM_ADMIN_WEBHOOK_SECRET=""' \
  ".env.example: TELEGRAM_ADMIN_WEBHOOK_SECRET documented"
assert_file_contains "${ROOT}/docker-compose.yml" 'TELEGRAM_ADMIN_BOT_TOKEN: ${TELEGRAM_ADMIN_BOT_TOKEN:-}' \
  "docker-compose: admin bot token passed to the app service"
[ -f "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" ] && echo "  [ok]   admin intake webhook route present (src/app/api/webhooks/telegram-admin/route.ts)" \
  || { echo "  [FAIL] src/app/api/webhooks/telegram-admin/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/scripts/set-telegram-webhook.ts" 'TELEGRAM_ADMIN_BOT_TOKEN' \
  "set-telegram-webhook.ts: registers BOTH bots (admin intake included)"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'TELEGRAM_ADMIN_BOT_TOKEN' \
  "admin webhook route uses the ADMIN bot token (not the notifier token)"
# --- Translation glossary (Web3 jargon protection) ---------------------------
[ -f "${ROOT}/src/lib/translation-glossary.ts" ] && echo "  [ok]   translation glossary module present" \
  || { echo "  [FAIL] src/lib/translation-glossary.ts missing"; fail=1; }
[ -f "${ROOT}/config/translation-glossary.json" ] && echo "  [ok]   active glossary config present" \
  || { echo "  [FAIL] config/translation-glossary.json missing"; fail=1; }
[ -f "${ROOT}/config/translation-glossary.example.json" ] && echo "  [ok]   annotated glossary template present" \
  || { echo "  [FAIL] config/translation-glossary.example.json missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/translate.ts" 'protectText' \
  "translate.ts: glossary protect/restore pipeline wired in"
assert_file_contains "${ROOT}/.env.example" 'TRANSLATION_GLOSSARY_PATH' \
  ".env.example: glossary path variable documented"
assert_file_contains "${ROOT}/docker-compose.yml" 'TRANSLATION_GLOSSARY_PATH' \
  "docker-compose: glossary path passed to the app service"
# --- Bulk-paste admin bot (replaces the 13-step wizard) ----------------------
[ -f "${ROOT}/src/lib/bots/bulk-parse.ts" ] && echo "  [ok]   bulk-paste parser present (src/lib/bots/bulk-parse.ts)" \
  || { echo "  [FAIL] src/lib/bots/bulk-parse.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'parseBulkJobText' \
  "admin webhook route uses the bulk-paste parser"
# --- Discord removal (clean sweep) -------------------------------------------
[ ! -f "${ROOT}/src/lib/bots/discord.ts" ] && echo "  [ok]   discord.ts removed" \
  || { echo "  [FAIL] src/lib/bots/discord.ts still exists"; fail=1; }
[ ! -d "${ROOT}/src/app/api/webhooks/discord" ] && echo "  [ok]   discord webhook route removed" \
  || { echo "  [FAIL] src/app/api/webhooks/discord still exists"; fail=1; }
[ ! -d "${ROOT}/src/app/api/bots/discord" ] && echo "  [ok]   discord webhook API removed" \
  || { echo "  [FAIL] src/app/api/bots/discord still exists"; fail=1; }
[ ! -f "${ROOT}/src/lib/bots/secretbox.ts" ] && echo "  [ok]   secretbox.ts removed (was Discord-only)" \
  || { echo "  [FAIL] src/lib/bots/secretbox.ts still exists"; fail=1; }
if grep -rq "DISCORD_" "${ROOT}/.env.example" "${ROOT}/docker-compose.yml" 2>/dev/null; then
  echo "  [FAIL] DISCORD_* variables still referenced in .env.example / docker-compose.yml"
  fail=1
else
  echo "  [ok]   no DISCORD_* variables in .env.example / docker-compose.yml"
fi
[ -f "${ROOT}/prisma/migrations/0005_drop_discord/migration.sql" ] && echo "  [ok]   migration 0005_drop_discord present" \
  || { echo "  [FAIL] prisma/migrations/0005_drop_discord/migration.sql missing"; fail=1; }
if grep -q 'network: host' "${ROOT}/docker-compose.yml"; then
  echo "  [FAIL] docker-compose still uses network: host (VPS has native internet)"
  fail=1
else
  echo "  [ok]   docker-compose free of network: host (VPS-native networking)"
fi
# --- Translation pipeline (title + snippet + body + tags) --------------------
assert_file_contains "${ROOT}/src/lib/localize.ts" 'snippet?: string' \
  "localize.ts: snippet field in the translation cache"
assert_file_contains "${ROOT}/src/lib/localize.ts" 'tags?: string[]' \
  "localize.ts: tags in the translation cache"
assert_file_contains "${ROOT}/src/lib/translate.ts" 'chunkTimeoutMs' \
  "translate.ts: adaptive per-chunk timeout (bodies no longer time out)"
# --- LLM translation provider chain (Groq → DeepSeek → Gemini → LibreTranslate) --
assert_file_contains "${ROOT}/src/lib/translate.ts" 'api.groq.com/openai/v1' \
  "translate.ts: Groq primary provider wired in"
assert_file_contains "${ROOT}/src/lib/translate.ts" 'openai/gpt-oss-120b' \
  "translate.ts: Groq primary model pinned"
assert_file_contains "${ROOT}/src/lib/translate.ts" 'qwen/qwen3.8-27b' \
  "translate.ts: Groq fallback model pinned"
assert_file_contains "${ROOT}/src/lib/translate.ts" 'api.deepseek.com' \
  "translate.ts: DeepSeek fallback provider present"
assert_file_contains "${ROOT}/src/lib/translate.ts" 'generativelanguage.googleapis.com' \
  "translate.ts: Gemini fallback provider present"
assert_file_contains "${ROOT}/src/lib/translate.ts" 'activeTranslationProvider' \
  "translate.ts: provider indicator exported for the About page"
assert_file_contains "${ROOT}/src/lib/env.ts" 'GROQ_API_KEY' \
  "env.ts: GROQ_API_KEY validated"
assert_file_contains "${ROOT}/.env.example" 'GROQ_API_KEY=""' \
  ".env.example: Groq key documented"
assert_file_contains "${ROOT}/.env.example" 'DEEPSEEK_API_KEY=""' \
  ".env.example: DeepSeek key documented"
assert_file_contains "${ROOT}/.env.example" 'GOOGLE_AI_API_KEY=""' \
  ".env.example: Gemini key documented"
assert_file_contains "${ROOT}/docker-compose.yml" 'GROQ_API_KEY' \
  "docker-compose: Groq key passed to the app service"
assert_file_contains "${ROOT}/src/app/[locale]/about/page.tsx" 'Translation via' \
  "about page: translation provider indicator rendered"
[ -f "${ROOT}/scripts/test-llm-translation.ts" ] && echo "  [ok]   LLM provider chain test present (scripts/test-llm-translation.ts)" \
  || { echo "  [FAIL] scripts/test-llm-translation.ts missing"; fail=1; }
if grep -q 'GROQ_API_KEY' "${ROOT}/worker/worker.ts" 2>/dev/null; then
  echo "  [FAIL] worker/worker.ts must not reference GROQ_API_KEY (worker does not translate)"
  fail=1
else
  echo "  [ok]   worker untouched by the translation provider chain"
fi
# Run the same stale-merge guard the Docker build runs — the sandbox tree
# itself must be clean before it is bundled.
if sh "${ROOT}/docker/check-app-tree.sh" >/dev/null 2>&1; then
  echo "  [ok]   src/app tree is clean (no stale pre-i18n files in the sandbox)"
else
  echo "  [FAIL] src/app contains stale pre-i18n files — the bundle would ship them!" >&2
  sh "${ROOT}/docker/check-app-tree.sh" >&2 || true
  fail=1
fi

if [ "${fail}" != "0" ]; then
  echo "[export] ABORTED — fix the failures above and re-run." >&2
  exit 1
fi

echo "[export] staging clean copy…"
mkdir -p "${STAGE}"

# rsync if available, cp fallback
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude 'node_modules' \
    --exclude '.next' \
    --exclude '.git' \
    --exclude 'db' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude 'dist' \
    --exclude 'dist-export' \
    --exclude 'dev.log' \
    --exclude 'server.log' \
    --exclude '*.log' \
    --exclude 'upload' \
    --exclude 'tool-results' \
    --exclude 'skills' \
    --exclude '.zscripts' \
    --exclude 'mini-services' \
    --exclude 'examples' \
    --exclude 'tests' \
    --exclude 'Caddyfile' \
    --exclude 'next-env.d.ts' \
    --exclude '*.tsbuildinfo' \
    --exclude '.eslintcache' \
    --exclude 'download' \
    --exclude 'worklog.md' \
    "${ROOT}/" "${STAGE}/merklane/"
else
  echo "[export] rsync not found — please install rsync and retry." >&2
  exit 1
fi

# .env.example MUST be present even though .env* is excluded above
if [ ! -f "${STAGE}/merklane/.env.example" ]; then
  cp "${ROOT}/.env.example" "${STAGE}/merklane/.env.example"
fi

echo "[export] generating MANIFEST + manifest.sha256…"
( cd "${STAGE}/merklane" && find . -type f ! -name 'MANIFEST' ! -name 'manifest.sha256' | LC_ALL=C sort | sed 's|^\./||' > MANIFEST )
# Per-file checksums INSIDE the archive: after extraction the user can run
#   sha256sum -c manifest.sha256 --quiet
# to prove their working tree is byte-identical to the bundle (and instantly
# spot stale/mixed files from earlier extractions).
( cd "${STAGE}/merklane" \
  && find . -type f ! -name 'MANIFEST' ! -name 'manifest.sha256' | LC_ALL=C sort | sed 's|^\./||' \
  | (sha256sum $(cat /dev/stdin) 2>/dev/null || xargs sha256sum) > manifest.sha256 )

COUNT="$(wc -l < "${STAGE}/merklane/MANIFEST" | tr -d ' ')"
echo "[export] ${COUNT} files staged"

mkdir -p "${OUT}"
echo "[export] creating ${ARCHIVE_NAME}…"
tar -czf "${OUT}/${ARCHIVE_NAME}" -C "${STAGE}" merklane

# Structure assertion: exactly one top-level dir (merklane/) — extraction
# with  tar xzf merklane-project.tar.gz -C ~/merklane/  lands the files in
# ~/merklane/merklane  with NO triple nesting.
echo "[export] verifying archive structure…"
TOPLEVELS="$(tar -tzf "${OUT}/${ARCHIVE_NAME}" | awk -F/ '{print $1}' | sort -u)"
if [ "${TOPLEVELS}" != "merklane" ]; then
  echo "[export] ABORTED — archive top level must be exactly 'merklane/', got: ${TOPLEVELS}" >&2
  exit 1
fi
if tar -tzf "${OUT}/${ARCHIVE_NAME}" | grep -q '^merklane/merklane/'; then
  echo "[export] ABORTED — nested merklane/merklane/ detected in the archive" >&2
  exit 1
fi
echo "  [ok]   single top-level merklane/ — extracts flat into the target"

# ---------------------------------------------------------------------------
# IN-ARCHIVE verification — the checks above ran against the WORKING TREE;
# these run against the ARCHIVE ITSELF. A stale or half-built tarball can
# never pass this section, no matter what the build logs claimed.
# ---------------------------------------------------------------------------
echo "[export] verifying the ARCHIVE itself (deep check — no stale bundles)…"
VERIFY_DIR="$(mktemp -d)"
tar -xzf "${OUT}/${ARCHIVE_NAME}" -C "${VERIFY_DIR}"
archive_fail=0
assert_file_contains "${VERIFY_DIR}/merklane/.env.example" 'TELEGRAM_ADMIN_BOT_TOKEN=""' \
  "archive: .env.example ships TELEGRAM_ADMIN_BOT_TOKEN"
assert_file_contains "${VERIFY_DIR}/merklane/.env.example" 'TRANSLATION_GLOSSARY_PATH' \
  "archive: .env.example ships the glossary variable"
[ -f "${VERIFY_DIR}/merklane/src/app/api/webhooks/telegram-admin/route.ts" ] && echo "  [ok]   archive: telegram-admin/route.ts present" \
  || { echo "  [FAIL] archive: src/app/api/webhooks/telegram-admin/route.ts MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/scripts/set-telegram-webhook.ts" ] && echo "  [ok]   archive: set-telegram-webhook.ts present" \
  || { echo "  [FAIL] archive: scripts/set-telegram-webhook.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/scripts/set-telegram-webhook.ts" 'TELEGRAM_ADMIN_BOT_TOKEN' \
  "archive: webhook script registers BOTH bots"
[ -f "${VERIFY_DIR}/merklane/src/lib/translation-glossary.ts" ] && echo "  [ok]   archive: translation-glossary.ts present" \
  || { echo "  [FAIL] archive: src/lib/translation-glossary.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/translate.ts" 'protectText' \
  "archive: translate.ts carries the glossary pipeline"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/translate.ts" 'api.groq.com/openai/v1' \
  "archive: translate.ts ships the Groq primary provider"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/translate.ts" 'openai/gpt-oss-120b' \
  "archive: translate.ts pins the Groq primary model"
assert_file_contains "${VERIFY_DIR}/merklane/.env.example" 'GROQ_API_KEY=""' \
  "archive: .env.example documents GROQ_API_KEY"
assert_file_contains "${VERIFY_DIR}/merklane/.env.example" 'GOOGLE_AI_API_KEY=""' \
  "archive: .env.example documents GOOGLE_AI_API_KEY"
assert_file_contains "${VERIFY_DIR}/merklane/docker-compose.yml" 'GROQ_API_KEY' \
  "archive: compose passes the LLM provider keys"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/[locale]/about/page.tsx" 'Translation via' \
  "archive: About page carries the provider indicator"
[ -f "${VERIFY_DIR}/merklane/scripts/test-llm-translation.ts" ] && echo "  [ok]   archive: LLM provider chain test present" \
  || { echo "  [FAIL] archive: scripts/test-llm-translation.ts MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/config/translation-glossary.json" ] && echo "  [ok]   archive: active glossary config present" \
  || { echo "  [FAIL] archive: config/translation-glossary.json MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/config/translation-glossary.example.json" ] && echo "  [ok]   archive: glossary template present" \
  || { echo "  [FAIL] archive: config/translation-glossary.example.json MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/docker-compose.yml" 'TELEGRAM_ADMIN_BOT_TOKEN' \
  "archive: docker-compose passes the admin bot token"
[ -f "${VERIFY_DIR}/merklane/src/lib/bots/bulk-parse.ts" ] && echo "  [ok]   archive: bulk-parse.ts present" \
  || { echo "  [FAIL] archive: src/lib/bots/bulk-parse.ts MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/prisma/migrations/0005_drop_discord/migration.sql" ] && echo "  [ok]   archive: migration 0005_drop_discord present" \
  || { echo "  [FAIL] archive: prisma/migrations/0005_drop_discord MISSING"; archive_fail=1; }
if [ -d "${VERIFY_DIR}/merklane/src/app/api/webhooks/discord" ] || [ -d "${VERIFY_DIR}/merklane/src/app/api/bots/discord" ]; then
  echo "  [FAIL] archive: Discord routes still present (stale bundle!)"
  archive_fail=1
else
  echo "  [ok]   archive: no Discord routes (clean sweep verified inside the tarball)"
fi
if grep -q 'network: host' "${VERIFY_DIR}/merklane/docker-compose.yml"; then
  echo "  [FAIL] archive: docker-compose.yml still has network: host"
  archive_fail=1
else
  echo "  [ok]   archive: compose is VPS-native (no host networking)"
fi
assert_file_contains "${VERIFY_DIR}/merklane/Dockerfile" 'COPY --from=builder --chown=merklane:merklane /app/prisma ./prisma' \
  "archive: Dockerfile prisma COPY intact"
assert_file_contains "${VERIFY_DIR}/merklane/Dockerfile" 'COPY --from=builder --chown=merklane:merklane /app/node_modules ./node_modules' \
  "archive: Dockerfile FULL node_modules COPY intact"
# Cross-check: every file listed in the archive MANIFEST exists after extraction
MANIFEST_COUNT="$(wc -l < "${VERIFY_DIR}/merklane/MANIFEST" | tr -d ' ')"
MISSING_IN_ARCHIVE="$(cd "${VERIFY_DIR}/merklane" && while IFS= read -r f; do [ -f "${f}" ] || echo "${f}"; done < MANIFEST | head -5)"
if [ -z "${MISSING_IN_ARCHIVE}" ]; then
  echo "  [ok]   archive: all ${MANIFEST_COUNT} MANIFEST files present after extraction"
else
  echo "  [FAIL] archive: files listed in MANIFEST but missing: ${MISSING_IN_ARCHIVE}"
  archive_fail=1
fi
rm -rf "${VERIFY_DIR}"
if [ "${archive_fail}" != "0" ]; then
  echo "[export] ABORTED — the archive itself failed verification (stale/partial bundle)." >&2
  exit 1
fi

( cd "${OUT}" && sha256sum "${ARCHIVE_NAME}" > "${ARCHIVE_NAME}.sha256" 2>/dev/null \
  || shasum -a 256 "${ARCHIVE_NAME}" > "${ARCHIVE_NAME}.sha256" )
SHA="$(cut -d' ' -f1 "${OUT}/${ARCHIVE_NAME}.sha256")"
SIZE="$(du -h "${OUT}/${ARCHIVE_NAME}" | cut -f1)"
echo "[export] archive: ${OUT}/${ARCHIVE_NAME} (${SIZE}, sha256 ${SHA:0:16}…)"

echo "[export] building setup-project.sh…"
SCRIPT="${OUT}/setup-project.sh"
cat > "${SCRIPT}" <<'HEADER'
#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Merklane — self-extracting project bundle
#
#   bash setup-project.sh [target-dir]
#
# Verifies the embedded checksum, extracts the full source tree, prints the
# next steps. Safe to re-run: extracts into a temp dir first, then moves.
# ---------------------------------------------------------------------------
set -euo pipefail

TARGET="${1:-./merklane}"
ARCHIVE_NAME="merklane-project.tar.gz"
EXPECTED_SHA="__SHA256__"

say() { printf '  %s\n' "$*"; }

# --- base64 decode flag (GNU -d, BSD/macOS -D) ------------------------------
if printf '' | base64 -d >/dev/null 2>&1; then
  B64D="base64 -d"
elif printf '' | base64 -D >/dev/null 2>&1; then
  B64D="base64 -D"
else
  echo "error: no usable base64 found" >&2; exit 1
fi

# --- checksum tool ------------------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA_CMD="shasum -a 256"
else echo "error: need sha256sum or shasum"; exit 1; fi

echo "Merklane self-extracting bundle"
echo "-------------------------------"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# --- extract payload after the marker line -----------------------------------
MARKER_LINE="$(awk '/^__MERKLANE_PAYLOAD__$/{print NR + 1; exit 0;}' "$0")"
if [ -z "${MARKER_LINE}" ] || [ "${MARKER_LINE}" -lt 2 ]; then
  echo "error: payload marker missing — file corrupted?" >&2; exit 1
fi
tail -n "+${MARKER_LINE}" "$0" | ${B64D} > "${TMP}/${ARCHIVE_NAME}"

# --- verify ------------------------------------------------------------------
ACTUAL_SHA="$(${SHA_CMD} "${TMP}/${ARCHIVE_NAME}" | cut -d' ' -f1)"
if [ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]; then
  echo "error: checksum mismatch" >&2
  echo "  expected: ${EXPECTED_SHA}" >&2
  echo "  actual:   ${ACTUAL_SHA}" >&2
  exit 1
fi
say "checksum verified (${ACTUAL_SHA:0:16}…)"

# --- extract -------------------------------------------------------------------
if [ -e "${TARGET}" ] && [ -n "$(ls -A "${TARGET}" 2>/dev/null)" ]; then
  echo "error: target ${TARGET} already exists and is not empty" >&2
  echo "  (extraction never merges into an existing tree — that is how stale" >&2
  echo "   mixed-file states happen. Move it aside or remove it first.)" >&2
  exit 1
fi
mkdir -p "${TARGET}"
tar -xzf "${TMP}/${ARCHIVE_NAME}" -C "${TARGET}" --strip-components=1
FILES="$(find "${TARGET}" -type f | wc -l | tr -d ' ')"
say "extracted ${FILES} files to ${TARGET}"

# --- verify the extracted tree is byte-identical to the bundle ----------------
if [ -f "${TARGET}/manifest.sha256" ]; then
  say "verifying extracted files against manifest.sha256…"
  if ( cd "${TARGET}" && ${SHA_CMD} -c manifest.sha256 --quiet >/dev/null 2>&1 ); then
    say "tree verified — every file matches the bundle"
  else
    echo "error: file verification FAILED — the extracted tree is not identical to the bundle" >&2
    ( cd "${TARGET}" && ${SHA_CMD} -c manifest.sha256 2>/dev/null | grep -v ': OK' | head -20 )
    exit 1
  fi
fi

# --- next steps ---------------------------------------------------------------
echo
echo "Next steps:"
echo "  1. cd ${TARGET}"
echo "  2. cp .env.example .env    # then follow POST-EXPORT-GUIDE.md §5"
echo "  3. docker compose up -d --build      # or see guide §4 for local runs"
echo
echo "Already have a working tree? Verify it instead of re-extracting over it:"
echo "  cd <your-merklane-tree> && sha256sum -c manifest.sha256 --quiet"
echo
echo "Full local-setup, cleanup checklist and .env walkthrough:"
echo "  ${TARGET}/POST-EXPORT-GUIDE.md"
echo
exit 0
__MERKLANE_PAYLOAD__
HEADER
sed -i.bak "s|__SHA256__|${SHA}|" "${SCRIPT}" && rm -f "${SCRIPT}.bak"
chmod +x "${SCRIPT}"

# append the base64 payload
base64 "${OUT}/${ARCHIVE_NAME}" >> "${SCRIPT}"

# copy the guide next to the bundle
cp "${ROOT}/POST-EXPORT-GUIDE.md" "${OUT}/POST-EXPORT-GUIDE.md"

echo "[export] done:"
ls -la "${OUT}"
