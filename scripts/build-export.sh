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
# The About-page translation indicator was REMOVED (user request) — guard
# against it creeping back in, along with its i18n keys.
if grep -q "translationVia" "${ROOT}/src/app/[locale]/about/page.tsx" 2>/dev/null; then
  echo "  [FAIL] about page still references translationVia (indicator was removed)"
  fail=1
else
  echo "  [ok]   about page free of the translation indicator (removed)"
fi
if grep -q "translationVia" "${ROOT}/src/i18n/messages/en.ts" 2>/dev/null; then
  echo "  [FAIL] en.ts still carries translationVia keys (removed feature)"
  fail=1
else
  echo "  [ok]   dictionaries free of translationVia keys"
fi
[ -f "${ROOT}/scripts/test-llm-translation.ts" ] && echo "  [ok]   LLM provider chain test present (scripts/test-llm-translation.ts)" \
  || { echo "  [FAIL] scripts/test-llm-translation.ts missing"; fail=1; }
if grep -q 'GROQ_API_KEY' "${ROOT}/worker/worker.ts" 2>/dev/null; then
  echo "  [FAIL] worker/worker.ts must not reference GROQ_API_KEY (worker does not translate)"
  fail=1
else
  echo "  [ok]   worker untouched by the translation provider chain"
fi
# --- Hashtag policy (#crypto is a functional identifier — never translated) ---
assert_file_contains "${ROOT}/src/lib/translate.ts" 'HASHTAG_RE' \
  "translate.ts: hashtag protection regex present (#crypto stays English)"
assert_file_contains "${ROOT}/src/lib/translate.ts" 'hashtags (words starting with #' \
  "translate.ts: LLM system prompt explicitly protects hashtags"
assert_file_contains "${ROOT}/src/lib/localize.ts" 'hashtag policy' \
  "localize.ts: tag translation removed (hashtag policy documented)"
# --- Section names stay English in EVERY locale (search/filter/routing) -------
for dict in "${ROOT}"/src/i18n/messages/*.ts; do
  dict_name="$(basename "${dict}")"
  if grep -q "internJunior: 'Intern/Junior'" "${dict}"; then
    echo "  [ok]   i18n ${dict_name}: section name 'Intern/Junior' stays English"
  else
    echo "  [FAIL] i18n ${dict_name}: 'internJunior' must stay English (routing consistency)"
    fail=1
  fi
done
# --- Global UI i18n (hero, search, quick links, cards, banner) ----------------
assert_file_contains "${ROOT}/src/app/[locale]/page.tsx" "namespace: 'hero'" \
  "home page: hero strings localized via next-intl"
assert_file_contains "${ROOT}/src/app/[locale]/page.tsx" "namespace: 'quickLinks'" \
  "home page: quick links localized via next-intl"
assert_file_contains "${ROOT}/src/components/site/search-box.tsx" "useTranslations('search')" \
  "search box: placeholder + button localized via next-intl"
assert_file_contains "${ROOT}/src/components/site/post-card.tsx" "useTranslations('postMeta')" \
  "post-card: metadata labels (Job/Internship/Remote/…) localized via next-intl"
assert_file_contains "${ROOT}/src/components/site/support-banner.tsx" "useTranslations('support')" \
  "support banner: strings localized via next-intl"
assert_file_contains "${ROOT}/src/components/site/section-head.tsx" 'viewAll' \
  "section-head: 'View all' link localized via next-intl"
# --- Job-post metadata rendering (pipe-separated line → one item per line) ----
assert_file_contains "${ROOT}/src/components/site/article-body.tsx" 'splitMetadataLines' \
  "article-body: pipe-separated metadata split at render time"
assert_file_contains "${ROOT}/src/components/site/article-body.tsx" 'METADATA_EMOJI_RE' \
  "article-body: split gated on metadata emojis (📍🕐💰 — markdown tables safe)"
# --- Team data + social links (dynamic TeamMember CMS) ------------------------
assert_file_contains "${ROOT}/src/lib/team.ts" 'SOCIAL_VAZIMA_URL' \
  "team seed: Vazima social link read from env"
assert_file_contains "${ROOT}/src/lib/team.ts" 'SOCIAL_TRINITY_URL' \
  "team seed: Trinity social link read from env"
assert_file_contains "${ROOT}/src/lib/team.ts" 'SOCIAL_GROBOFHIK_URL' \
  "team seed: Grobofhik social link read from env"
assert_file_contains "${ROOT}/src/lib/team.ts" 'team_vazima_bio' \
  "team seed: legacy SiteSetting overrides merged on first read"
assert_file_contains "${ROOT}/.env.example" 'SOCIAL_VAZIMA_URL=""' \
  ".env.example: team social link variables documented"
assert_file_contains "${ROOT}/.env.example" 'SOCIAL_TRINITY_URL=""' \
  ".env.example: Trinity social link documented"
assert_file_contains "${ROOT}/.env.example" 'SOCIAL_GROBOFHIK_URL=""' \
  ".env.example: Grobofhik social link documented"
assert_file_contains "${ROOT}/docker-compose.yml" 'SOCIAL_VAZIMA_URL: ${SOCIAL_VAZIMA_URL:-}' \
  "docker-compose: team social links passed to the app service"
assert_file_contains "${ROOT}/src/app/[locale]/about/page.tsx" 'target="_blank"' \
  "about page: team cards open social links in a new tab"
assert_file_contains "${ROOT}/src/app/[locale]/about/page.tsx" 'rel="noopener noreferrer"' \
  "about page: social links carry rel=noopener noreferrer"
if grep -rq 'McQween' "${ROOT}/src" "${ROOT}/.env.example" "${ROOT}/docker-compose.yml" 2>/dev/null; then
  echo "  [FAIL] placeholder team member 'McQween' still referenced"
  fail=1
else
  echo "  [ok]   placeholder team member 'McQween' fully removed"
fi
[ -f "${ROOT}/scripts/ui18n-codegen/check-messages.ts" ] && echo "  [ok]   i18n ICU message compile check present" \
  || { echo "  [FAIL] scripts/ui18n-codegen/check-messages.ts missing"; fail=1; }
# --- Ads system + site CMS + legacy design (2026 build) -----------------------
assert_file_contains "${ROOT}/prisma/schema.prisma" 'model SiteSetting' \
  "schema: SiteSetting (Telegram CMS key-value store)"
assert_file_contains "${ROOT}/prisma/schema.prisma" 'model CryptoTopUp' \
  "schema: CryptoTopUp model"
[ -f "${ROOT}/prisma/migrations/0006_site_cms_ads/migration.sql" ] && echo "  [ok]   migration 0006_site_cms_ads present" \
  || { echo "  [FAIL] prisma/migrations/0006_site_cms_ads missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/topup.ts" 'deriveDepositAddress' \
  "topup.ts: deterministic deposit-address derivation (manual fallback)"
assert_file_contains "${ROOT}/src/lib/ads/topup.ts" 'confirmTopUp' \
  "topup.ts: idempotent confirmation + crediting"
assert_file_contains "${ROOT}/src/lib/ads/topup.ts" "blockbeeConfigured() ? 'blockbee' : 'manual'" \
  "topup.ts: AUTO mode resolution (blockbee when key set, else manual)"
# --- Ads Phase 1: double-entry wallet, campaign structure, budget reservations --
for PHASE1_MODEL in Wallet LedgerEntry Campaign Creative BudgetReservation; do
  assert_file_contains "${ROOT}/prisma/schema.prisma" "model ${PHASE1_MODEL} " \
    "schema: ${PHASE1_MODEL} model (PostgreSQL dialect)"
  assert_file_contains "${ROOT}/prisma/schema.sqlite.prisma" "model ${PHASE1_MODEL} " \
    "schema: ${PHASE1_MODEL} model (SQLite preview dialect)"
done
[ -f "${ROOT}/prisma/migrations/0011_ads_phase1_double_entry/migration.sql" ] && echo "  [ok]   migration 0011_ads_phase1_double_entry present" \
  || { echo "  [FAIL] prisma/migrations/0011_ads_phase1_double_entry missing"; fail=1; }
assert_file_contains "${ROOT}/prisma/migrations/0011_ads_phase1_double_entry/migration.sql" "migrate:campaign:" \
  "migration 0011: deterministic legacy-data transform ids"
assert_file_contains "${ROOT}/prisma/migrations/0011_ads_phase1_double_entry/migration.sql" 'DROP TABLE IF EXISTS "AdCampaign"' \
  "migration 0011: legacy AdCampaign teardown"
assert_file_contains "${ROOT}/src/lib/ads/money.ts" 'MICRO_PER_USD = 1_000_000' \
  'money.ts: micro-USD integer unit ($1.00 = 1,000,000)'
assert_file_contains "${ROOT}/src/lib/ads/money.ts" 'cpmPerViewMicro' \
  "money.ts: CPM per-view division (bid/1000)"
assert_file_contains "${ROOT}/src/lib/ads/money.ts" 'MIN_BUDGET_EVENTS = 20' \
  "money.ts: minimum flight rule (20 billable events)"
assert_file_contains "${ROOT}/src/lib/ads/wallet.ts" 'creditWalletTopUp' \
  "wallet.ts: top-up credit movement (CREDIT ledger row)"
assert_file_contains "${ROOT}/src/lib/ads/wallet.ts" 'reserveCampaignBudget' \
  "wallet.ts: campaign budget reservation (RESERVE ledger row)"
assert_file_contains "${ROOT}/src/lib/ads/wallet.ts" 'chargeReservation' \
  "wallet.ts: charge movement (CHARGE ledger row, unique eventId)"
assert_file_contains "${ROOT}/src/lib/ads/wallet.ts" 'refundCampaignBudget' \
  "wallet.ts: delete-refund movement (REFUND ledger row)"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'pickWeightedRandom' \
  "auction.ts: weighted-random (roulette wheel) selection"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'pickPoolAndDraw' \
  "auction.ts: 50/50 CPC/CPM pool split + in-pool weighted draw"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'RESERVATION_TTL_MS = 30 * 60 * 1000' \
  "auction.ts: 30-minute CPC hold TTL (spec)"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'expireStaleReservations' \
  "auction.ts: sweeper flips overdue HELD rows to EXPIRED"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'finalizeClick' \
  "auction.ts: valid-click finalisation (conditional status flip + charge)"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'campaignBudgetStates' \
  "auction.ts: ledger-derived budget state (no mutable balance column)"
assert_file_contains "${ROOT}/src/lib/ads/topup.ts" 'creditWalletTopUp' \
  "topup.ts: confirmTopUp credits the unified wallet"
assert_file_contains "${ROOT}/src/lib/ads/topup.ts" 'eventId: `topup:${topUp.id}`' \
  "topup.ts: credit eventId idempotent against IPN retries"
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/route.ts" "format: z.enum(['text', 'banner'])" \
  "campaigns POST: format selectable independently of billing"
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/route.ts" "billingModel: z.enum(['cpc', 'cpm'])" \
  "campaigns POST: exactly one billing model per campaign"
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/[id]/route.ts" "action: z.enum(['pause', 'resume', 'fund', 'update', 'delete', 'submit'])" \
  "campaigns PATCH: six actions incl. submit (Phase 2) + soft delete"
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/[id]/route.ts" 'refundCampaignBudget' \
  "campaigns PATCH delete: unspent budget refunded to the wallet"
assert_file_contains "${ROOT}/src/app/api/ads/wallet/route.ts" 'ledger:' \
  "wallet GET: exposes the immutable ledger (double-entry trail)"
assert_file_contains "${ROOT}/src/app/api/ads/click/[token]/route.ts" 'payload.r' \
  "click route: keyed by the signed reservation id (Phase 3 token payload)"
assert_file_contains "${ROOT}/src/components/site/ads/ad-slot.tsx" "ad.format === 'banner'" \
  "AdSlot: banner format renders the image creative"
assert_file_contains "${ROOT}/src/components/site/ads/ad-slot.tsx" 'reservationId' \
  "AdSlot: ServedAd carries the reservation id (debug/analytics)"
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" 'billingCpc' \
  "wizard: billing model chips (CPC — pay per click)"
assert_file_contains "${ROOT}/src/components/site/ads/ads-dashboard.tsx" 'formatBanner' \
  "dashboard: format chips (Text / Banner)"
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" 'bidSuffixCpc' \
  "wizard: bid shown in the model's unit ($/click, $/1000 views)"
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" 'dailyBudgetLabel' \
  "wizard: daily budget field"
assert_file_contains "${ROOT}/src/components/site/ads/ads-dashboard.tsx" 'ledgerTitle' \
  "dashboard: wallet ledger table"
assert_file_contains "${ROOT}/src/components/site/ads/ads-dashboard.tsx" 'deleteBtn' \
  "dashboard: delete action (refund on delete)"
# every dictionary carries the Phase-1 ads keys (grep loop, all 20 locales)
PHASE1_COUNT="$(ls -1 "${ROOT}/src/i18n/messages" | grep -c '\.ts$')"
PHASE1_OK=0
for PHASE1_FILE in "${ROOT}"/src/i18n/messages/*.ts; do
  if grep -q "bidSuffixCpc:" "${PHASE1_FILE}" && grep -q "ledgerTitle:" "${PHASE1_FILE}" && grep -q "statusCompleted:" "${PHASE1_FILE}" && grep -q "estClicks:" "${PHASE1_FILE}"; then
    PHASE1_OK=$((PHASE1_OK + 1))
  else
    echo "  [FAIL] ${PHASE1_FILE##*/}: missing Phase-1 ads keys (bidSuffixCpc/ledgerTitle/statusCompleted/estClicks)"
    fail=1
  fi
done
[ "${PHASE1_OK}" -eq "${PHASE1_COUNT}" ] && echo "  [ok]   Phase-1 ads keys present in ${PHASE1_OK}/${PHASE1_COUNT} dictionaries" \
  || { echo "  [FAIL] Phase-1 ads keys: only ${PHASE1_OK}/${PHASE1_COUNT} dictionaries covered"; fail=1; }
# legacy models fully swept from the application source (they live on ONLY in
# the migration SQL, which legitimately references the tables it transforms)
if grep -rEq 'adBalance|AdImpression|bidPerView|AdCampaign' "${ROOT}/src"; then
  echo "  [FAIL] pre-phase ads model still referenced in src/ (stale code)"
  grep -rEn 'adBalance|AdImpression|bidPerView|AdCampaign' "${ROOT}/src" | head -5
  fail=1
else
  echo "  [ok]   no pre-phase ads model references left in src/"
fi
# e2e suites updated to the Phase-1 contract
[ -f "${ROOT}/scripts/test-ads-e2e.ts" ] && echo "  [ok]   ads e2e suite present" \
  || { echo "  [FAIL] scripts/test-ads-e2e.ts missing"; fail=1; }
assert_file_contains "${ROOT}/scripts/test-ads-e2e.ts" 'ledgerInvariant' \
  "ads e2e: wallet invariant (available+reserved == Σcredit−Σcharge)"
assert_file_contains "${ROOT}/scripts/test-ads-e2e.ts" 'out_of_budget' \
  "ads e2e: resume out-of-budget rejection covered"
assert_file_contains "${ROOT}/scripts/test-ads-auction.ts" 'pickPoolAndDraw' \
  "auction unit tests: pool split covered"
[ -f "${ROOT}/scripts/apply-migration-sql.ts" ] && echo "  [ok]   local migration applier present" \
  || { echo "  [FAIL] scripts/apply-migration-sql.ts missing"; fail=1; }
# --- Ads Phase 2: wizard, banner uploads, advanced targeting, moderation ----
[ -f "${ROOT}/prisma/migrations/0012_ads_phase2_targeting_moderation/migration.sql" ] && echo "  [ok]   migration 0012_ads_phase2_targeting_moderation present" \
  || { echo "  [FAIL] prisma/migrations/0012_ads_phase2_targeting_moderation missing"; fail=1; }
assert_file_contains "${ROOT}/prisma/migrations/0012_ads_phase2_targeting_moderation/migration.sql" 'ADD COLUMN "targetKeywords"' \
  "migration 0012: keyword targeting column"
assert_file_contains "${ROOT}/prisma/migrations/0012_ads_phase2_targeting_moderation/migration.sql" 'ADD COLUMN "countryMode"' \
  "migration 0012: country filter mode column"
assert_file_contains "${ROOT}/prisma/migrations/0012_ads_phase2_targeting_moderation/migration.sql" 'ADD COLUMN "moderationNote"' \
  "migration 0012: rejection-reason column"
for PHASE2_COL in targetKeywords keywordMatch countryMode targetCountries targetHashtags; do
  assert_file_contains "${ROOT}/prisma/schema.prisma" "${PHASE2_COL} " "schema (pg): Campaign.${PHASE2_COL} targeting"
  assert_file_contains "${ROOT}/prisma/schema.sqlite.prisma" "${PHASE2_COL} " "schema (sqlite): Campaign.${PHASE2_COL} targeting"
done
assert_file_contains "${ROOT}/prisma/schema.prisma" 'moderationStatus String @default("draft")' \
  "schema (pg): Creative.moderationStatus lifecycle"
assert_file_contains "${ROOT}/prisma/schema.sqlite.prisma" 'moderationStatus String @default("draft")' \
  "schema (sqlite): Creative.moderationStatus lifecycle"
assert_file_contains "${ROOT}/prisma/schema.prisma" 'deletedAt' \
  "schema (pg): Campaign soft delete (deletedAt)"
assert_file_contains "${ROOT}/prisma/schema.sqlite.prisma" 'deletedAt' \
  "schema (sqlite): Campaign soft delete (deletedAt)"
[ -f "${ROOT}/src/lib/ads/targeting.ts" ] && echo "  [ok]   targeting lib present" \
  || { echo "  [FAIL] src/lib/ads/targeting.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/targeting.ts" 'export function targetingMatches' \
  "targeting.ts: auction-facing matcher (unknown-inventory rule)"
[ -f "${ROOT}/src/lib/ads/moderation.ts" ] && echo "  [ok]   moderation state machine present" \
  || { echo "  [FAIL] src/lib/ads/moderation.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/moderation.ts" 'export async function submitCampaignForReview' \
  "moderation.ts: submit for review (DRAFT/REJECTED → PENDING)"
assert_file_contains "${ROOT}/src/lib/ads/moderation.ts" 'export async function approveCampaign' \
  "moderation.ts: approve (PENDING → ACTIVE)"
assert_file_contains "${ROOT}/src/lib/ads/moderation.ts" 'export async function rejectCampaign' \
  "moderation.ts: reject with reason (PENDING → REJECTED)"
[ -f "${ROOT}/src/app/api/ads/assets/upload/route.ts" ] && echo "  [ok]   banner upload route present" \
  || { echo "  [FAIL] src/app/api/ads/assets/upload/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/ads/assets/upload/route.ts" 'MAX_BYTES = 1_572_864' \
  "upload route: 1.5 MB hard cap"
assert_file_contains "${ROOT}/src/app/api/ads/assets/upload/route.ts" 'function sniffImageType' \
  "upload route: magic-byte content sniffing (PNG/JPEG/WebP only)"
assert_file_contains "${ROOT}/src/app/api/ads/assets/upload/route.ts" "'/uploads/ads'" \
  "upload route: local storage prefix (no external URLs)"
[ -f "${ROOT}/src/components/site/ads/campaign-wizard.tsx" ] && echo "  [ok]   campaign wizard present" \
  || { echo "  [FAIL] src/components/site/ads/campaign-wizard.tsx missing"; fail=1; }
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" 'TOTAL_STEPS = 5' \
  "wizard: five steps"
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" 'wizardStepOf' \
  "wizard: progress bar (Step N of 5)"
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" 'btnSaveDraft' \
  "wizard: save as draft from every step"
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" 'keywordMatch' \
  "wizard: keyword match mode UI (phrase/exact)"
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" 'countryMode' \
  "wizard: country mode UI (all/include/exclude)"
assert_file_contains "${ROOT}/src/components/site/ads/ads-dashboard.tsx" 'moderationNote' \
  "dashboard: rejection reason surfaced on REJECTED campaigns"
assert_file_contains "${ROOT}/src/components/site/ads/ads-dashboard.tsx" "'draft' | 'pending'" \
  "dashboard: draft/pending/rejected states modelled"
[ -f "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" ] && echo "  [ok]   admin bot route present" \
  || { echo "  [FAIL] src/app/api/webhooks/telegram-admin/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" '🛡 Moderation Queue' \
  "admin bot: moderation queue menu entry"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'modok:' \
  "admin bot: approve button"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'modno:' \
  "admin bot: reject button"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'reject-reason' \
  "admin bot: rejection reason capture"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'REJECT_REASON_MIN' \
  "admin bot: reason length bounds"
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/route.ts" 'submit: z.boolean().default(false)' \
  "campaigns API: create-as-draft vs submit-for-review"
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/route.ts" "keywordMatch: z.enum(['phrase', 'exact'])" \
  "campaigns API: keyword match mode validation"
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/route.ts" "countryMode: z.enum(['all', 'include', 'exclude'])" \
  "campaigns API: country mode validation"
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/[id]/route.ts" "z.enum(['pause', 'resume', 'fund', 'update', 'delete', 'submit'])" \
  "campaigns API: PATCH submit action (revisions → PENDING)"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'targetingMatches' \
  "auction: consumes the Phase-2 targeting matcher"
# every dictionary carries the Phase-2 wizard keys (grep loop, all 20 locales)
PHASE2_COUNT="$(ls -1 "${ROOT}/src/i18n/messages" | grep -c '\.ts$')"
PHASE2_OK=0
for PHASE2_FILE in "${ROOT}"/src/i18n/messages/*.ts; do
  if grep -q "wizardStepOf:" "${PHASE2_FILE}" && grep -q "btnSaveDraft:" "${PHASE2_FILE}" && grep -q "countryModeInclude:" "${PHASE2_FILE}"; then
    PHASE2_OK=$((PHASE2_OK + 1))
  else
    echo "  [FAIL] ${PHASE2_FILE##*/}: missing Phase-2 wizard keys (wizardStepOf/btnSaveDraft/countryModeInclude)"
    fail=1
  fi
done
[ "${PHASE2_OK}" -eq "${PHASE2_COUNT}" ] && echo "  [ok]   Phase-2 wizard keys present in ${PHASE2_OK}/${PHASE2_COUNT} dictionaries" \
  || { echo "  [FAIL] Phase-2 wizard keys: only ${PHASE2_OK}/${PHASE2_COUNT} dictionaries covered"; fail=1; }
# e2e suite rewritten for the Phase-2 contract
assert_file_contains "${ROOT}/scripts/test-ads-e2e.ts" 'Phase 2' \
  "ads e2e: suite covers Phase 2 (wizard/uploads/moderation)"
assert_file_contains "${ROOT}/scripts/test-ads-e2e.ts" 'content sniffing' \
  "ads e2e: upload content sniffing covered"

# --- Ads Phase 3: event pipeline, viewability, anti-fraud, reporting ------
[ -f "${ROOT}/prisma/migrations/0013_ads_phase3_events/migration.sql" ] && echo "  [ok]   migration 0013_ads_phase3_events present" \
  || { echo "  [FAIL] prisma/migrations/0013_ads_phase3_events missing"; fail=1; }
assert_file_contains "${ROOT}/prisma/migrations/0013_ads_phase3_events/migration.sql" 'CREATE TABLE "AdEvent"' \
  "migration 0013: AdEvent delivery log"
assert_file_contains "${ROOT}/prisma/migrations/0013_ads_phase3_events/migration.sql" 'CREATE UNIQUE INDEX "AdEvent_reservationId_eventType_key"' \
  "migration 0013: exactly-once event guard (unique reservation+type)"
for PHASE3_SCHEMA in schema.prisma schema.sqlite.prisma; do
  assert_file_contains "${ROOT}/prisma/${PHASE3_SCHEMA}" 'model AdEvent' \
    "schema (${PHASE3_SCHEMA}): AdEvent model"
  assert_file_contains "${ROOT}/prisma/${PHASE3_SCHEMA}" '@@unique([reservationId, eventType])' \
    "schema (${PHASE3_SCHEMA}): AdEvent exactly-once unique index"
done
[ -f "${ROOT}/src/lib/ads/tokens.ts" ] && echo "  [ok]   HMAC ad-token lib present" \
  || { echo "  [FAIL] src/lib/ads/tokens.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/tokens.ts" 'export function signAdToken' \
  "tokens.ts: token minting (serve-time HMAC)"
assert_file_contains "${ROOT}/src/lib/ads/tokens.ts" 'export function verifyAdToken' \
  "tokens.ts: token verification (constant-time)"
[ -f "${ROOT}/src/lib/ads/events.ts" ] && echo "  [ok]   AdEvent logging lib present" \
  || { echo "  [FAIL] src/lib/ads/events.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/events.ts" "'loaded_impression' | 'viewable_impression' | 'valid_click'" \
  "events.ts: the three funnel stages logged separately"
assert_file_contains "${ROOT}/src/lib/ads/events.ts" 'duplicate: true' \
  "events.ts: replayed events resolve as duplicates (never a second charge)"
[ -f "${ROOT}/src/lib/ads/antifraud.ts" ] && echo "  [ok]   anti-fraud lib present" \
  || { echo "  [FAIL] src/lib/ads/antifraud.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/antifraud.ts" 'export function isKnownBot' \
  "antifraud.ts: User-Agent bot filter (serve/click/event)"
assert_file_contains "${ROOT}/src/lib/ads/antifraud.ts" 'export function hashVisitorIp' \
  "antifraud.ts: salted visitor-IP hash (never the raw IP)"
[ -f "${ROOT}/src/app/api/ads/click/[token]/route.ts" ] && echo "  [ok]   signed click redirect route present" \
  || { echo "  [FAIL] src/app/api/ads/click/[token]/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/ads/click/[token]/route.ts" 'verifyAdToken' \
  "click route: HMAC validation before anything billable"
assert_file_contains "${ROOT}/src/app/api/ads/click/[token]/route.ts" 'finalizeClick' \
  "click route: the only CPC billing event (held → finalized + charge)"
assert_file_contains "${ROOT}/src/app/api/ads/click/[token]/route.ts" "status: 302" \
  "click route: 302 redirect to the signed destination"
[ -f "${ROOT}/src/app/api/ads/event/route.ts" ] && echo "  [ok]   viewability beacon endpoint present" \
  || { echo "  [FAIL] src/app/api/ads/event/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/ads/event/route.ts" 'viewable_impression' \
  "event route: viewability beacons only"
assert_file_contains "${ROOT}/src/app/api/ads/event/route.ts" 'finalizeView' \
  "event route: the only CPM billing event"
assert_file_contains "${ROOT}/src/app/api/ads/event/route.ts" 'EVENT_RATE_LIMIT' \
  "event route: per-IP rate limit (anti-spam)"
assert_file_contains "${ROOT}/src/app/api/ads/serve/route.ts" 'isKnownBot' \
  "serve route: bots get no ad (no reservation, no event)"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'finalizeView' \
  "auction: CPM finalisation moved to the view event"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" "eventType: 'loaded_impression'" \
  "auction: serve logs the loaded_impression event server-side"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'clickToken' \
  "auction: every serve mints the HMAC ad token"
if grep -qF "ChargeGuardFailed" "${ROOT}/src/lib/ads/auction.ts" 2>/dev/null; then
  echo "  [FAIL] auction.ts still carries the Phase-1 CPM charge-at-serve path"
  fail=1
else
  echo "  [ok]   auction.ts: charging at SERVE time removed (validated events only)"
fi
assert_file_contains "${ROOT}/src/components/site/ads/ad-slot.tsx" 'IntersectionObserver' \
  "AdSlot: viewability measured with the IntersectionObserver (≥ 50 %)"
assert_file_contains "${ROOT}/src/components/site/ads/ad-slot.tsx" 'VIEWABLE_MS' \
  "AdSlot: one continuous second (VIEWABLE_MS)"
assert_file_contains "${ROOT}/src/components/site/ads/ad-slot.tsx" "visibilitychange" \
  "AdSlot: Page Visibility API (active-tab requirement)"
assert_file_contains "${ROOT}/src/components/site/ads/ad-slot.tsx" "'/api/ads/event'" \
  "AdSlot: viewability beacon endpoint"
assert_file_contains "${ROOT}/src/components/site/ads/ad-slot.tsx" 'api/ads/click/' \
  "AdSlot: clicks go through the signed redirect route"
[ -f "${ROOT}/src/lib/ads/reporting.ts" ] && echo "  [ok]   reporting aggregation lib present" \
  || { echo "  [FAIL] src/lib/ads/reporting.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/reporting.ts" 'campaignReportRows' \
  "reporting.ts: per-campaign metrics aggregation"
assert_file_contains "${ROOT}/src/lib/ads/reporting.ts" 'ecpcMicroUsd' \
  "reporting.ts: eCPC = spent / clicks"
[ -f "${ROOT}/src/lib/ads/report-format.ts" ] && echo "  [ok]   report display formats present" \
  || { echo "  [FAIL] src/lib/ads/report-format.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/report-format.ts" "NO_DATA = '—'" \
  "report-format.ts: em dash for no-data metrics (never \$0.00 / 0%)"
[ -f "${ROOT}/src/app/api/ads/reports/route.ts" ] && echo "  [ok]   reports API route present" \
  || { echo "  [FAIL] src/app/api/ads/reports/route.ts missing"; fail=1; }
[ -f "${ROOT}/src/app/api/ads/reports/export/route.ts" ] && echo "  [ok]   CSV export route present" \
  || { echo "  [FAIL] src/app/api/ads/reports/export/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/ads/reports/export/route.ts" 'sanitizeCsvCell' \
  "CSV export: formula-injection guard"
assert_file_contains "${ROOT}/src/app/api/ads/reports/export/route.ts" 'FORMULA_PREFIX' \
  "CSV export: leading = + - @ neutralised"
assert_file_contains "${ROOT}/src/app/api/ads/reports/export/route.ts" '\uFEFF' \
  "CSV export: UTF-8 BOM for Excel"
[ -f "${ROOT}/src/components/site/ads/ads-reports.tsx" ] && echo "  [ok]   Reports tab component present" \
  || { echo "  [FAIL] src/components/site/ads/ads-reports.tsx missing"; fail=1; }
assert_file_contains "${ROOT}/src/components/site/ads/ads-reports.tsx" 'AdsReportsView' \
  "reports view: mounted component"
assert_file_contains "${ROOT}/src/components/site/ads/ads-reports.tsx" 'downloadCsv' \
  "reports view: Download CSV button"
assert_file_contains "${ROOT}/src/components/site/ads/ads-dashboard.tsx" "tabReports" \
  "dashboard: third tab (Reports) wired"
assert_file_contains "${ROOT}/src/components/site/ads/ads-dashboard.tsx" "view === 'reports'" \
  "dashboard: reports view branch"
assert_file_contains "${ROOT}/src/lib/env.ts" 'ADS_EVENT_SECRET' \
  "env: dedicated ads HMAC secret (falls back to AUTH_SECRET)"
assert_file_contains "${ROOT}/.env.example" 'ADS_EVENT_SECRET' \
  ".env.example: ADS_EVENT_SECRET documented"
# every dictionary carries the Phase-3 reports keys (grep loop, all 20 locales)
PHASE3_COUNT="$(ls -1 "${ROOT}/src/i18n/messages" | grep -c '\.ts$')"
PHASE3_OK=0
for PHASE3_FILE in "${ROOT}"/src/i18n/messages/*.ts; do
  if grep -q "tabReports:" "${PHASE3_FILE}" && grep -q "downloadCsv:" "${PHASE3_FILE}" && grep -q "colEcpc:" "${PHASE3_FILE}"; then
    PHASE3_OK=$((PHASE3_OK + 1))
  else
    echo "  [FAIL] ${PHASE3_FILE##*/}: missing Phase-3 reports keys (tabReports/downloadCsv/colEcpc)"
    fail=1
  fi
done
[ "${PHASE3_OK}" -eq "${PHASE3_COUNT}" ] && echo "  [ok]   Phase-3 reports keys present in ${PHASE3_OK}/${PHASE3_COUNT} dictionaries" \
  || { echo "  [FAIL] Phase-3 reports keys: only ${PHASE3_OK}/${PHASE3_COUNT} dictionaries covered"; fail=1; }
# Phase-3 e2e: the events suite (HTTP + real Chromium viewability/click)
[ -f "${ROOT}/scripts/test-ads-events-e2e.ts" ] && echo "  [ok]   Phase-3 events e2e suite present" \
  || { echo "  [FAIL] scripts/test-ads-events-e2e.ts missing"; fail=1; }
[ -f "${ROOT}/scripts/run-ads-events-e2e.sh" ] && echo "  [ok]   events e2e runner present" \
  || { echo "  [FAIL] scripts/run-ads-events-e2e.sh missing"; fail=1; }
assert_file_contains "${ROOT}/scripts/test-ads-events-e2e.ts" 'IntersectionObserver' \
  "events e2e: the viewability contract is tested"
assert_file_contains "${ROOT}/scripts/test-ads-events-e2e.ts" 'viewable_impression' \
  "events e2e: viewable impressions covered"
assert_file_contains "${ROOT}/scripts/test-ads-events-e2e.ts" 'chromium' \
  "events e2e: a real Chromium pass (Playwright)"
assert_file_contains "${ROOT}/scripts/test-ads-events-e2e.ts" 'formula' \
  "events e2e: CSV injection covered"

# --- Ads Phase 4: A/B testing, forecasting, admin roles & audit log -------
[ -f "${ROOT}/prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" ] && echo "  [ok]   migration 0014_ads_phase4_abtest_forecast_audit present" \
  || { echo "  [FAIL] prisma/migrations/0014_ads_phase4_abtest_forecast_audit missing"; fail=1; }
assert_file_contains "${ROOT}/prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" 'CREATE TABLE "Experiment"' \
  "migration 0014: Experiment model"
assert_file_contains "${ROOT}/prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" 'CREATE TABLE "VariantAssignment"' \
  "migration 0014: VariantAssignment model"
assert_file_contains "${ROOT}/prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" 'CREATE UNIQUE INDEX "VariantAssignment_experimentId_visitorId_key"' \
  "migration 0014: one arm per visitor per experiment"
assert_file_contains "${ROOT}/prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" 'CREATE TABLE "AuditLog"' \
  "migration 0014: AuditLog model"
assert_file_contains "${ROOT}/prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" 'ADD COLUMN "adminRole" TEXT NOT NULL DEFAULT '\''owner'\''' \
  "migration 0014: User.adminRole defaults to owner (nobody loses rights)"
assert_file_contains "${ROOT}/prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" 'ADD COLUMN "variantId" TEXT' \
  "migration 0014: BudgetReservation.variantId attribution stamp"
assert_file_contains "${ROOT}/prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" 'ADD COLUMN "section" TEXT' \
  "migration 0014: AdEvent section context (forecast input)"
for PHASE4_SCHEMA in schema.prisma schema.sqlite.prisma; do
  assert_file_contains "${ROOT}/prisma/${PHASE4_SCHEMA}" 'model Experiment' \
    "schema (${PHASE4_SCHEMA}): Experiment model"
  assert_file_contains "${ROOT}/prisma/${PHASE4_SCHEMA}" 'model VariantAssignment' \
    "schema (${PHASE4_SCHEMA}): VariantAssignment model"
  assert_file_contains "${ROOT}/prisma/${PHASE4_SCHEMA}" 'model AuditLog' \
    "schema (${PHASE4_SCHEMA}): AuditLog model"
  assert_file_contains "${ROOT}/prisma/${PHASE4_SCHEMA}" 'adminRole     String    @default("owner")' \
    "schema (${PHASE4_SCHEMA}): User.adminRole tier"
done
[ -f "${ROOT}/src/lib/ads/experiments.ts" ] && echo "  [ok]   A/B engine present" \
  || { echo "  [FAIL] src/lib/ads/experiments.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/experiments.ts" 'export function variantForVisitor' \
  "experiments.ts: stable-hash 50/50 assignment"
assert_file_contains "${ROOT}/src/lib/ads/experiments.ts" 'export function twoProportionZTest' \
  "experiments.ts: two-proportion z-test on CTR"
assert_file_contains "${ROOT}/src/lib/ads/experiments.ts" 'MIN_SAMPLE_PER_ARM = 100' \
  "experiments.ts: the 100-impressions-per-arm significance gate"
assert_file_contains "${ROOT}/src/lib/ads/experiments.ts" 'SIGNIFICANCE_ALPHA = 0.05' \
  "experiments.ts: p ≤ 0.05 for a winner"
[ -f "${ROOT}/src/lib/ads/forecast.ts" ] && echo "  [ok]   forecast engine present" \
  || { echo "  [FAIL] src/lib/ads/forecast.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/forecast.ts" 'FORECAST_MIN_PLATFORM_IMPRESSIONS = 1000' \
  "forecast.ts: the 1000-impression honesty gate"
assert_file_contains "${ROOT}/src/lib/ads/forecast.ts" 'FORECAST_WINDOW_DAYS = 7' \
  "forecast.ts: 7-day lookback window"
[ -f "${ROOT}/src/lib/ads/permissions.ts" ] && echo "  [ok]   permission tiers present" \
  || { echo "  [FAIL] src/lib/ads/permissions.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/permissions.ts" "['owner', 'editor']" \
  "permissions.ts: campaign management = OWNER + EDITOR"
assert_file_contains "${ROOT}/src/lib/ads/permissions.ts" "['owner', 'editor', 'analyst']" \
  "permissions.ts: reports = OWNER + EDITOR + ANALYST"
assert_file_contains "${ROOT}/src/lib/ads/permissions.ts" "['owner', 'billing']" \
  "permissions.ts: balance adjustments = OWNER + BILLING"
[ -f "${ROOT}/src/lib/ads/audit.ts" ] && echo "  [ok]   audit log writer present" \
  || { echo "  [FAIL] src/lib/ads/audit.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/audit.ts" 'APPROVE_CAMPAIGN' \
  "audit.ts: campaign approvals audited"
assert_file_contains "${ROOT}/src/lib/ads/audit.ts" 'REJECT_CAMPAIGN' \
  "audit.ts: campaign rejections audited (with the reason)"
assert_file_contains "${ROOT}/src/lib/ads/audit.ts" 'ADJUST_BALANCE' \
  "audit.ts: balance adjustments audited"
# serve path: the variant is chosen AFTER the draw (single auction weight)
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'variantForVisitor' \
  "auction.ts: A/B variant chosen after the campaign wins"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'recordVariantAssignment' \
  "auction.ts: visitor assignments persisted"
assert_file_contains "${ROOT}/src/lib/ads/antifraud.ts" 'export function visitorStableId' \
  "antifraud.ts: stable server-minted visitor id"
# routes
for PHASE4_ROUTE in \
  "src/app/api/ads/campaigns/[id]/experiments/route.ts" \
  "src/app/api/ads/experiments/[id]/route.ts" \
  "src/app/api/ads/forecast/route.ts" \
  "src/app/api/admin/audit-log/route.ts" \
  "src/app/api/admin/users/role/route.ts"; do
  [ -f "${ROOT}/${PHASE4_ROUTE}" ] && echo "  [ok]   route present: ${PHASE4_ROUTE}" \
    || { echo "  [FAIL] ${PHASE4_ROUTE} missing"; fail=1; }
done
assert_file_contains "${ROOT}/src/app/api/ads/forecast/route.ts" 'AD_SECTION_CONTEXTS' \
  "forecast route: only known sections honoured"
# permission gates wired into the existing routes
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/route.ts" 'canManageCampaigns' \
  "campaigns API: creation gate (OWNER + EDITOR)"
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/[id]/route.ts" 'canManageCampaigns' \
  "campaigns API: mutation/budget gate (OWNER + EDITOR)"
assert_file_contains "${ROOT}/src/app/api/ads/reports/route.ts" 'canViewReports' \
  "reports API: view gate (OWNER + EDITOR + ANALYST)"
assert_file_contains "${ROOT}/src/app/api/ads/reports/export/route.ts" 'canViewReports' \
  "reports export: view gate (OWNER + EDITOR + ANALYST)"
assert_file_contains "${ROOT}/src/app/api/admin/ads/topups/[id]/confirm/route.ts" 'canAdjustBalance' \
  "admin confirm: balance gate (OWNER + BILLING)"
assert_file_contains "${ROOT}/src/app/api/admin/ads/topups/[id]/confirm/route.ts" 'ADJUST_BALANCE' \
  "admin confirm: audit row with the credited amount"
# audit writes in the moderation + bot paths
assert_file_contains "${ROOT}/src/lib/ads/moderation.ts" 'logAdminAction' \
  "moderation: approve/reject audited"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'resolveTelegramAdminActor' \
  "admin bot: actor resolution for the audit trail"
# UI
[ -f "${ROOT}/src/components/site/ads/ab-testing.tsx" ] && echo "  [ok]   A/B Testing panel present" \
  || { echo "  [FAIL] src/components/site/ads/ab-testing.tsx missing"; fail=1; }
assert_file_contains "${ROOT}/src/components/site/ads/ab-testing.tsx" 'abInsufficient' \
  "A/B panel: the honest 'Insufficient data' verdict line"
assert_file_contains "${ROOT}/src/components/site/ads/ads-dashboard.tsx" 'AbTestingPanel' \
  "dashboard: the A/B Testing tab wired into the campaign details"
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" '/api/ads/forecast' \
  "wizard Step 4: the delivery forecast box"
assert_file_contains "${ROOT}/src/components/site/ads/campaign-wizard.tsx" 'forecastInsufficient' \
  "wizard Step 4: the 'Insufficient data to forecast' fallback"
# e2e coverage of the Phase-4 contract
assert_file_contains "${ROOT}/scripts/test-ads-events-e2e.ts" 'variantForVisitor' \
  "events e2e: A/B assignment covered (white-box hash)"
assert_file_contains "${ROOT}/scripts/test-ads-events-e2e.ts" 'single auction weight' \
  "events e2e: single-weight check present"
assert_file_contains "${ROOT}/scripts/test-ads-events-e2e.ts" 'Insufficient data to forecast' \
  "events e2e: the forecast fallback covered"
assert_file_contains "${ROOT}/scripts/test-ads-events-e2e.ts" 'forbidden_role' \
  "events e2e: permission tiers covered"
assert_file_contains "${ROOT}/scripts/test-ads-events-e2e.ts" 'REJECT_CAMPAIGN' \
  "events e2e: audit rows covered"
# every dictionary carries the Phase-4 keys (grep loop, all 20 locales)
PHASE4_COUNT="$(ls -1 "${ROOT}/src/i18n/messages" | grep -c '\.ts$')"
PHASE4_OK=0
for PHASE4_FILE in "${ROOT}"/src/i18n/messages/*.ts; do
  if grep -q "abTab:" "${PHASE4_FILE}" && grep -q "abInsufficient:" "${PHASE4_FILE}" && grep -q "forecastInsufficient:" "${PHASE4_FILE}"; then
    PHASE4_OK=$((PHASE4_OK + 1))
  else
    echo "  [FAIL] ${PHASE4_FILE##*/}: missing Phase-4 keys (abTab/abInsufficient/forecastInsufficient)"
    fail=1
  fi
done
[ "${PHASE4_OK}" -eq "${PHASE4_COUNT}" ] && echo "  [ok]   Phase-4 keys present in ${PHASE4_OK}/${PHASE4_COUNT} dictionaries" \
  || { echo "  [FAIL] Phase-4 keys: only ${PHASE4_OK}/${PHASE4_COUNT} dictionaries covered"; fail=1; }
# --- BlockBee processor + referral system (2026 payments build) ----------------
assert_file_contains "${ROOT}/prisma/schema.prisma" 'model PaymentLog' \
  "schema: PaymentLog audit trail"
assert_file_contains "${ROOT}/prisma/schema.prisma" 'model ReferralWithdrawal' \
  "schema: ReferralWithdrawal ledger"
assert_file_contains "${ROOT}/prisma/schema.prisma" 'referralBalance Int' \
  "schema: User.referralBalance (US cents)"
assert_file_contains "${ROOT}/prisma/schema.prisma" 'callbackNonce' \
  "schema: CryptoTopUp per-intention webhook nonce"
[ -f "${ROOT}/prisma/migrations/0007_blockbee_referrals/migration.sql" ] && echo "  [ok]   migration 0007_blockbee_referrals present" \
  || { echo "  [FAIL] prisma/migrations/0007_blockbee_referrals missing"; fail=1; }
[ -f "${ROOT}/src/lib/ads/blockbee.ts" ] && echo "  [ok]   BlockBee client present" \
  || { echo "  [FAIL] src/lib/ads/blockbee.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/blockbee.ts" 'verifyWebhookSignature' \
  "blockbee.ts: dual-scheme webhook signature verification"
assert_file_contains "${ROOT}/src/lib/ads/blockbee.ts" "return t === 'trx' || t.startsWith('trc20')" \
  "blockbee.ts: TRON ban (policy, not overridable)"
assert_file_contains "${ROOT}/src/lib/ads/blockbee.ts" 'createPaymentIntention' \
  "blockbee.ts: payment intention via /create/"
assert_file_contains "${ROOT}/src/lib/ads/blockbee.ts" 'payout/request/create' \
  "blockbee.ts: payout chain endpoints"
[ -f "${ROOT}/src/lib/referral.ts" ] && echo "  [ok]   referral lib present" \
  || { echo "  [FAIL] src/lib/referral.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/referral.ts" 'REFERRAL_RATE = 0.5' \
  "referral.ts: 50% commission rate"
assert_file_contains "${ROOT}/src/lib/referral.ts" 'creditReferralCommission' \
  "referral.ts: tx-scoped exactly-once commission credit"
[ -f "${ROOT}/src/lib/payment-log.ts" ] && echo "  [ok]   PaymentLog writer present" \
  || { echo "  [FAIL] src/lib/payment-log.ts missing"; fail=1; }
[ -f "${ROOT}/src/app/api/webhooks/blockbee/route.ts" ] && echo "  [ok]   BlockBee webhook route present" \
  || { echo "  [FAIL] src/app/api/webhooks/blockbee/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/webhooks/blockbee/route.ts" "rateLimit(\`blockbee-wh:" \
  "webhook: per-IP rate limit (spam hardening)"
assert_file_contains "${ROOT}/src/app/api/webhooks/blockbee/route.ts" 'nonce_mismatch' \
  "webhook: per-intention nonce validation"
assert_file_contains "${ROOT}/src/app/api/webhooks/blockbee/route.ts" 'referralBalance: { gte:' \
  "webhook: deduction guarded against negative balance"
[ -f "${ROOT}/src/app/api/account/referral/withdraw/route.ts" ] && echo "  [ok]   referral withdraw route present" \
  || { echo "  [FAIL] src/app/api/account/referral/withdraw/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/account/referral/withdraw/route.ts" 'processPayout' \
  "withdraw: BlockBee payout chain drive"
assert_file_contains "${ROOT}/src/lib/env.ts" 'BLOCKBEE_IPN_SECRET' \
  "env.ts: BlockBee variables validated"
assert_file_contains "${ROOT}/.env.example" 'BLOCKBEE_API_KEY=""' \
  ".env.example: BlockBee documented"
assert_file_contains "${ROOT}/docker-compose.yml" 'BLOCKBEE_API_KEY: ${BLOCKBEE_API_KEY:-}' \
  "compose: BlockBee env passed to the app"
assert_file_contains "${ROOT}/src/components/site/profile-dashboard.tsx" 'ReferralTab' \
  "profile dashboard: Referrals tab renders"
assert_file_contains "${ROOT}/src/i18n/messages/ru.ts" 'topUpBlockbeeNote' \
  "i18n: BlockBee top-up keys translated (ru spot-check)"
assert_file_contains "${ROOT}/src/i18n/messages/ja.ts" 'topUpCoinNote' \
  "i18n: coin-picker keys translated (ja spot-check)"
[ -f "${ROOT}/scripts/test-blockbee-e2e.ts" ] && echo "  [ok]   BlockBee e2e suite present" \
  || { echo "  [FAIL] scripts/test-blockbee-e2e.ts missing"; fail=1; }
[ -f "${ROOT}/src/lib/site-settings.ts" ] && echo "  [ok]   site-settings lib present (CMS read cache)" \
  || { echo "  [FAIL] src/lib/site-settings.ts missing"; fail=1; }
[ -f "${ROOT}/src/components/site/ads/ad-slot.tsx" ] && echo "  [ok]   <AdSlot/> component present" \
  || { echo "  [FAIL] src/components/site/ads/ad-slot.tsx missing"; fail=1; }
assert_file_contains "${ROOT}/src/components/site/ads/ad-slot.tsx" 'rel="sponsored noopener noreferrer"' \
  "AdSlot: rel=sponsored (never confused with editorial links)"
[ -f "${ROOT}/src/components/site/ads/ads-dashboard.tsx" ] && echo "  [ok]   advertiser dashboard component present" \
  || { echo "  [FAIL] src/components/site/ads/ads-dashboard.tsx missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/[locale]/page.tsx" 'slot="home_banner"' \
  "home page: banner slot below the hero"
assert_file_contains "${ROOT}/src/components/site/post-list-client.tsx" 'slot="feed"' \
  "section pages: in-feed ad after the 3rd/6th post"
assert_file_contains "${ROOT}/src/app/[locale]/[section]/[slug]/page.tsx" 'slot="article_bottom"' \
  "article pages: native ad before the comments"
assert_file_contains "${ROOT}/src/app/[locale]/ads/page.tsx" "'/profile/ads'" \
  "/ads: permanent redirect into the profile cabinet"
assert_file_contains "${ROOT}/src/app/[locale]/profile/ads/page.tsx" "redirect('/auth?mode=login&next=/profile/ads')" \
  "/profile/ads dashboard: auth-gated like the profile cabinet"
assert_file_contains "${ROOT}/src/app/api/ads/serve/route.ts" 'status: 204' \
  "serve API: 204 when nothing eligible (no empty boxes)"
assert_file_contains "${ROOT}/src/app/api/ads/serve/route.ts" 'AD_SECTION_CONTEXTS' \
  "serve API: section/locale targeting context"
[ -f "${ROOT}/src/lib/ads/wallet.ts" ] && echo "  [ok]   ad-wallet allocation lib present (conditional-decrement)" \
  || { echo "  [FAIL] src/lib/ads/wallet.ts missing"; fail=1; }
[ -f "${ROOT}/src/lib/ads/targeting.ts" ] && echo "  [ok]   campaign targeting lib present (sections + locales)" \
  || { echo "  [FAIL] src/lib/ads/targeting.ts missing"; fail=1; }
[ -f "${ROOT}/src/app/api/ads/wallet/route.ts" ] && echo "  [ok]   /api/ads/wallet Wallet-tab route present" \
  || { echo "  [FAIL] src/app/api/ads/wallet/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/ads/campaigns/route.ts" 'insufficient_wallet' \
  "campaign create: wallet gate enforced (no unfunded campaigns)"
[ -f "${ROOT}/src/app/api/ads/topups/[id]/simulate/route.ts" ] && echo "  [ok]   simulate (demo) top-up route present" \
  || { echo "  [FAIL] ads topups simulate route missing"; fail=1; }
[ -f "${ROOT}/src/app/api/admin/ads/topups/[id]/confirm/route.ts" ] && echo "  [ok]   admin manual-confirm route present" \
  || { echo "  [FAIL] admin ads topups confirm route missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/env.ts" 'ADS_TOPUP_MODE' \
  "env.ts: ads top-up mode validated"
assert_file_contains "${ROOT}/.env.example" 'ADS_ENABLED="true"' \
  ".env.example: ads master switch documented"
assert_file_contains "${ROOT}/.env.example" 'ADS_TOPUP_MODE=""' \
  ".env.example: top-up mode documented (auto default)"
assert_file_contains "${ROOT}/.env.example" 'ADS_TOPUP_SEED=""' \
  ".env.example: deposit-address seed documented"
assert_file_contains "${ROOT}/docker-compose.yml" 'ADS_TOPUP_MODE: ${ADS_TOPUP_MODE:-}' \
  "docker-compose: ads env passthrough"
# --- Telegram bot CMS (Manage team / Change logo) ------------------------------
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'Manage team' \
  "admin bot: 👥 Manage team menu"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'Change logo' \
  "admin bot: 🖼 Change logo menu"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram-admin/route.ts" 'handlePhoto' \
  "admin bot: photo upload handler wired"
assert_file_contains "${ROOT}/src/lib/bots/telegram.ts" 'telegramDownloadAsDataUrl' \
  "telegram lib: file download → data URL (CMS uploads)"
assert_file_contains "${ROOT}/src/app/[locale]/about/page.tsx" 'getTeamMembers' \
  "about page: dynamic team from the TeamMember table"
if grep -qF 'object-contain' "${ROOT}/src/app/[locale]/about/page.tsx"; then
  echo "  [FAIL] about page: logo <img> is back in the visible UI (favicon-only branding)"
  fail=1
else
  echo "  [ok]   about page: no logo <img> rendered (favicon-only branding)"
fi
[ -f "${ROOT}/src/app/api/favicon/route.ts" ] && echo "  [ok]   /api/favicon dynamic favicon route present" \
  || { echo "  [FAIL] src/app/api/favicon/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/layout.tsx" "icon: '/api/favicon'" \
  "root layout: browser tab icon served by /api/favicon"
# --- Legacy design restored (de-slop rolled back) -------------------------------
[ ! -f "${ROOT}/src/app/globals.legacy.css" ] && echo "  [ok]   globals.legacy.css gone (restored as the live globals.css)" \
  || { echo "  [FAIL] src/app/globals.legacy.css still present — the design was rolled back, it must not ship twice"; fail=1; }
assert_file_contains "${ROOT}/src/app/globals.css" 'original template design (restored' \
  "globals.css: legacy template design restored as the live stylesheet"
if grep -qF 'var(--font-display)' "${ROOT}/src/app/globals.css"; then
  echo "  [FAIL] globals.css still wires the de-slop display font (Space Grotesk)"
  fail=1
else
  echo "  [ok]   globals.css: no de-slop display-font tokens"
fi
if grep -qF '.ad-slot' "${ROOT}/src/app/globals.css"; then
  echo "  [FAIL] globals.css still carries de-slop .ad-slot styles (components now use Tailwind utilities)"
  fail=1
else
  echo "  [ok]   globals.css: no de-slop ad-slot styles"
fi
assert_file_contains "${ROOT}/src/app/[locale]/layout.tsx" "import { Inter } from 'next/font/google'" \
  "layout: original Inter font setup restored"
if grep -qF 'Space_Grotesk' "${ROOT}/src/app/[locale]/layout.tsx"; then
  echo "  [FAIL] layout.tsx still loads Space Grotesk"
  fail=1
else
  echo "  [ok]   layout: Space Grotesk removed (Inter only)"
fi
assert_file_contains "${ROOT}/src/components/site/ads/ad-slot.tsx" 'SLOT_BASE' \
  "AdSlot: sponsored chrome via standard Tailwind utilities (legacy-safe)"
# --- i18n: ads/adSlot namespaces in every dictionary ----------------------------
ads_i18n_ok=0
for dict in "${ROOT}"/src/i18n/messages/*.ts; do
  dict_name="$(basename "${dict}")"
  if grep -q 'ads: {' "${dict}" && grep -q 'adSlot: {' "${dict}"; then
    ads_i18n_ok=$((ads_i18n_ok + 1))
  else
    echo "  [FAIL] i18n ${dict_name}: ads/adSlot namespace missing"
    fail=1
  fi
done
[ "${ads_i18n_ok}" -eq 20 ] && echo "  [ok]   ads/adSlot namespaces present in all 20 dictionaries"
[ -f "${ROOT}/scripts/test-ads-e2e.ts" ] && echo "  [ok]   ads e2e suite present" \
  || { echo "  [FAIL] scripts/test-ads-e2e.ts missing"; fail=1; }
[ -f "${ROOT}/scripts/test-ads-auction.ts" ] && echo "  [ok]   auction unit test present" \
  || { echo "  [FAIL] scripts/test-ads-auction.ts missing"; fail=1; }

# --- Premium subscriptions (stage-2 billing: checkout, paywall, quotas) --------
assert_file_contains "${ROOT}/src/lib/premium/plan.ts" 'monthlyCents: 500' \
  'premium: catalog price $5.00/month'
assert_file_contains "${ROOT}/src/lib/premium/plan.ts" 'yearlyCents: 3000' \
  'premium: catalog price $30.00/year (save 50%)'
assert_file_contains "${ROOT}/src/lib/premium/plan.ts" 'monthlyCents: 1500' \
  'premium: catalog price $15.00/month (Premium+)'
assert_file_contains "${ROOT}/src/lib/premium/plan.ts" 'yearlyCents: 9000' \
  'premium: catalog price $90.00/year (Premium+)'
assert_file_contains "${ROOT}/src/lib/premium/plan.ts" "PREMIUM_ORDER_PREFIXES = ['prem_m_', 'prem_y_', 'premplus_m_', 'premplus_y_']" \
  "premium: BlockBee order-id routing prefixes"
assert_file_contains "${ROOT}/src/lib/premium/plan.ts" 'PERIOD_DAYS' \
  "premium: 30/365-day period table"
assert_file_contains "${ROOT}/src/lib/premium/orders.ts" 'UNDERPAYMENT_TOLERANCE' \
  "premium: underpayment policy (<90% never activates)"
assert_file_contains "${ROOT}/src/lib/premium/orders.ts" 'confirmPremiumOrder' \
  "premium: exactly-once activation guard"
assert_file_contains "${ROOT}/src/app/api/premium/checkout/route.ts" "z.enum(['premium', 'premium_plus'])" \
  "premium: checkout accepts only the two paid plans"
assert_file_contains "${ROOT}/src/app/api/premium/checkout/route.ts" 'PLAN_PRICING' \
  "premium: checkout prices come from the server-side catalog (no client amounts)"
[ -f "${ROOT}/src/app/api/premium/checkout/[id]/route.ts" ] && echo "  [ok]   premium: order polling route present" \
  || { echo "  [FAIL] src/app/api/premium/checkout/[id]/route.ts missing"; fail=1; }
assert_file_contains "${ROOT}/src/app/api/webhooks/blockbee/route.ts" 'isPremiumOrderId' \
  "premium: IPN webhook routes prem_/premplus_ orders separately from ads"
assert_file_contains "${ROOT}/src/app/api/webhooks/blockbee/route.ts" 'confirmPremiumOrder' \
  "premium: webhook confirms subscriptions exactly once"
assert_file_contains "${ROOT}/src/lib/bots/dispatch.ts" "plan: { in: ['premium', 'premium_plus'] }" \
  "premium: dispatch paywall — only active paid plans receive job alerts"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram/route.ts" 'Job alerts are a Premium feature' \
  "premium: /alerts on rejection message ships"
assert_file_contains "${ROOT}/src/app/api/webhooks/telegram/route.ts" 'planDisplayName' \
  "premium: /whoami shows the plan"
assert_file_contains "${ROOT}/src/app/api/posts/route.ts" 'isPremiumPlusActive' \
  "premium+: editorial publishing gate"
assert_file_contains "${ROOT}/src/app/api/posts/route.ts" 'EDITORIAL_MONTHLY_QUOTA' \
  "premium+: monthly editorial quota enforced"
assert_file_contains "${ROOT}/src/components/site/site-header.tsx" 'premiumActive' \
  "premium: header reflects the subscription status"
assert_file_contains "${ROOT}/src/components/providers/session-provider.tsx" 'sessionPremiumActive' \
  "premium: client-side entitlement helper"
assert_file_contains "${ROOT}/src/components/site/pricing-plans.tsx" 'PLAN_PRICING' \
  "premium: pricing page renders from the server catalog"
assert_file_contains "${ROOT}/src/components/site/pricing-plans.tsx" 'checkoutPay' \
  "premium: BlockBee checkout modal ships"
assert_file_contains "${ROOT}/prisma/schema.prisma" 'model PremiumOrder' \
  "premium: PremiumOrder model in the schema"
assert_file_contains "${ROOT}/prisma/schema.sqlite.prisma" 'model PremiumOrder' \
  "premium: sqlite schema mirror carries PremiumOrder"
[ -f "${ROOT}/prisma/migrations/0009_premium_orders/migration.sql" ] && echo "  [ok]   premium: migration 0009 present" \
  || { echo "  [FAIL] prisma/migrations/0009_premium_orders/migration.sql missing"; fail=1; }
[ -f "${ROOT}/scripts/test-premium-e2e.ts" ] && echo "  [ok]   premium e2e suite present" \
  || { echo "  [FAIL] scripts/test-premium-e2e.ts missing"; fail=1; }
[ -f "${ROOT}/scripts/run-premium-e2e.sh" ] && echo "  [ok]   premium e2e runner present" \
  || { echo "  [FAIL] scripts/run-premium-e2e.sh missing"; fail=1; }
assert_file_contains "${ROOT}/package.json" 'premium:grant' \
  "premium: operator grant CLI registered"
[ -f "${ROOT}/scripts/grant-premium.ts" ] && echo "  [ok]   premium: grant/revoke CLI present" \
  || { echo "  [FAIL] scripts/grant-premium.ts missing"; fail=1; }
# i18n: premium namespace + header.premiumActive in EVERY dictionary
prem_i18n_ok=0
for dict in "${ROOT}"/src/i18n/messages/*.ts; do
  dict_name="$(basename "${dict}")"
  if grep -q 'premium: {' "${dict}" && grep -q 'premiumActive:' "${dict}"; then
    prem_i18n_ok=$((prem_i18n_ok + 1))
  else
    echo "  [FAIL] i18n ${dict_name}: premium namespace / header.premiumActive missing"
    fail=1
  fi
done
[ "${prem_i18n_ok}" -eq 20 ] && echo "  [ok]   premium namespace present in all 20 dictionaries"
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
  # Every directory/name exclude is ANCHORED with a leading "/" so it
  # matches ONLY at the tree root. Unanchored rsync patterns match the
  # basename at ANY depth: the original unanchored `--exclude 'upload'`
  # (meant for the top-level sandbox uploads dir) silently ALSO stripped
  # src/app/api/ads/assets/upload — the Phase 2 banner-upload route — out
  # of the archive while the file sat safely in the working tree. That is
  # exactly how a "fresh" export shipped a stale bundle. Wildcard/cache
  # patterns (*.log, *.tsbuildinfo, .eslintcache) stay unanchored on
  # purpose — they are safe to match at any depth.
  rsync -a \
    --exclude '/node_modules' \
    --exclude '/.next' \
    --exclude '/.git' \
    --exclude '/db' \
    --exclude '/.env' \
    --exclude '/.env.*' \
    --exclude '/dist' \
    --exclude '/dist-export' \
    --exclude '/dev.log' \
    --exclude '/server.log' \
    --exclude '*.log' \
    --exclude '/upload' \
    --exclude '/tool-results' \
    --exclude '/skills' \
    --exclude '/.zscripts' \
    --exclude '/mini-services' \
    --exclude '/examples' \
    --exclude '/tests' \
    --exclude '/Caddyfile' \
    --exclude '/next-env.d.ts' \
    --exclude '*.tsbuildinfo' \
    --exclude '/.eslintcache' \
    --exclude '/download' \
    --exclude '/worklog.md' \
    "${ROOT}/" "${STAGE}/merklane/"
else
  echo "[export] rsync not found — please install rsync and retry." >&2
  exit 1
fi

# .env.example MUST be present even though .env* is excluded above
if [ ! -f "${STAGE}/merklane/.env.example" ]; then
  cp "${ROOT}/.env.example" "${STAGE}/merklane/.env.example"
fi

# ---------------------------------------------------------------------------
# Staging structural guard — the tarball is created from THIS tree, so this
# is the last chance to catch files that exist in the working tree but were
# dropped by an exclude pattern, or were never saved at all (the exact bug
# that shipped a Phase-2 bundle without the banner-upload route while the
# route sat in src/). A miss here aborts the export BEFORE the tarball is
# written, so a broken bundle can never reach the output dir.
# ---------------------------------------------------------------------------
stage_fail=0
for STAGE_MUST in \
  "src/app/api/ads/assets/upload/route.ts" \
  "src/app/api/uploads/[...path]/route.ts" \
  "public/uploads/ads/README.txt" \
  "src/components/site/ads/campaign-wizard.tsx" \
  "src/components/site/ads/ads-dashboard.tsx" \
  "src/components/site/ads/ad-slot.tsx" \
  "src/components/site/ads/ads-reports.tsx" \
  "src/lib/ads/moderation.ts" \
  "src/lib/ads/targeting.ts" \
  "src/lib/ads/wallet.ts" \
  "src/lib/ads/auction.ts" \
  "src/lib/ads/money.ts" \
  "src/lib/ads/tokens.ts" \
  "src/lib/ads/events.ts" \
  "src/lib/ads/antifraud.ts" \
  "src/lib/ads/reporting.ts" \
  "src/lib/ads/report-format.ts" \
  "src/app/api/ads/serve/route.ts" \
  "src/app/api/ads/click/[token]/route.ts" \
  "src/app/api/ads/event/route.ts" \
  "src/app/api/ads/reports/route.ts" \
  "src/app/api/ads/reports/export/route.ts" \
  "src/app/api/webhooks/telegram-admin/route.ts" \
  "src/app/api/webhooks/blockbee/route.ts" \
  "prisma/schema.prisma" \
  "prisma/schema.sqlite.prisma" \
  "prisma/migrations/0011_ads_phase1_double_entry/migration.sql" \
  "prisma/migrations/0012_ads_phase2_targeting_moderation/migration.sql" \
  "prisma/migrations/0013_ads_phase3_events/migration.sql" \
  "prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" \
  "scripts/test-ads-e2e.ts" \
  "scripts/test-ads-events-e2e.ts" \
  "scripts/run-ads-events-e2e.sh" \
  "scripts/ui18n-codegen/inject-ads-phase3.ts" \
  "src/app/api/ads/campaigns/[id]/experiments/route.ts" \
  "src/app/api/ads/experiments/[id]/route.ts" \
  "src/app/api/ads/forecast/route.ts" \
  "src/app/api/admin/audit-log/route.ts" \
  "src/app/api/admin/users/role/route.ts" \
  "src/lib/ads/experiments.ts" \
  "src/lib/ads/forecast.ts" \
  "src/lib/ads/permissions.ts" \
  "src/lib/ads/audit.ts" \
  "src/components/site/ads/ab-testing.tsx" \
  "src/i18n/messages/en.ts"; do
  if [ -f "${STAGE}/merklane/${STAGE_MUST}" ]; then
    echo "  [ok]   staged: ${STAGE_MUST}"
  else
    echo "  [FAIL] staged tree missing ${STAGE_MUST}" >&2
    echo "         (an exclude pattern dropped it, or the file was never saved)" >&2
    stage_fail=1
  fi
done
if [ "${stage_fail}" != "0" ]; then
  echo "[export] ABORTED — the staged tree is incomplete (see above)." >&2
  exit 1
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
if grep -q "translationVia" "${VERIFY_DIR}/merklane/src/app/[locale]/about/page.tsx" 2>/dev/null \
  || grep -q "translationVia" "${VERIFY_DIR}/merklane/src/i18n/messages/en.ts" 2>/dev/null; then
  echo "  [FAIL] archive: translation indicator still present (removed feature)"
  archive_fail=1
else
  echo "  [ok]   archive: translation indicator fully removed"
fi
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
# --- Hashtag policy / UI i18n / metadata split / team — IN-ARCHIVE -------------
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/translate.ts" 'HASHTAG_RE' \
  "archive: hashtag protection ships (functional identifiers stay English)"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/translate.ts" 'hashtags (words starting with #' \
  "archive: LLM system prompt protects hashtags"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/localize.ts" 'hashtag policy' \
  "archive: tags-not-translated policy ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/i18n/messages/ru.ts" "internJunior: 'Intern/Junior'" \
  "archive: ru dictionary keeps section names English"
assert_file_contains "${VERIFY_DIR}/merklane/src/i18n/messages/ja.ts" "internJunior: 'Intern/Junior'" \
  "archive: ja dictionary keeps section names English"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/article-body.tsx" 'splitMetadataLines' \
  "archive: job-post metadata split ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/article-body.tsx" 'METADATA_EMOJI_RE' \
  "archive: metadata split emoji gate ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/team.ts" 'SOCIAL_VAZIMA_URL' \
  "archive: team social env wiring ships"
assert_file_contains "${VERIFY_DIR}/merklane/.env.example" 'SOCIAL_VAZIMA_URL=""' \
  "archive: .env.example documents team social links"
assert_file_contains "${VERIFY_DIR}/merklane/docker-compose.yml" 'SOCIAL_TRINITY_URL' \
  "archive: compose passes team social links"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/post-card.tsx" "useTranslations('postMeta')" \
  "archive: post-card metadata localization ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/support-banner.tsx" "useTranslations('support')" \
  "archive: support banner localization ships"
if grep -rq 'McQween' "${VERIFY_DIR}/merklane/src" 2>/dev/null; then
  echo "  [FAIL] archive: placeholder 'McQween' still present"
  archive_fail=1
else
  echo "  [ok]   archive: no 'McQween' placeholder (team is Vazima/Trinity/Grobofhik)"
fi
# --- Ads system + site CMS + legacy design — IN-ARCHIVE ------------------------
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/auction.ts" 'pickWeightedRandom' \
  "archive: weighted-random auction engine ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/topup.ts" 'deriveDepositAddress' \
  "archive: crypto top-up derivation ships"
[ -f "${VERIFY_DIR}/merklane/src/components/site/ads/ad-slot.tsx" ] && echo "  [ok]   archive: <AdSlot/> component ships" \
  || { echo "  [FAIL] archive: ad-slot.tsx MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/src/components/site/ads/ads-dashboard.tsx" ] && echo "  [ok]   archive: advertiser dashboard ships" \
  || { echo "  [FAIL] archive: ads-dashboard.tsx MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/prisma/migrations/0006_site_cms_ads/migration.sql" ] && echo "  [ok]   archive: migration 0006 ships" \
  || { echo "  [FAIL] archive: prisma/migrations/0006_site_cms_ads MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/.env.example" 'BLOCKBEE_API_KEY=""' \
  "archive: .env.example documents the BlockBee vars"
assert_file_contains "${VERIFY_DIR}/merklane/docker-compose.yml" 'ADS_TOPUP_MODE' \
  "archive: compose passes the ads env"
assert_file_contains "${VERIFY_DIR}/merklane/docker-compose.yml" 'BLOCKBEE_IPN_SECRET: ${BLOCKBEE_IPN_SECRET:-}' \
  "archive: compose passes the BlockBee env"
[ -f "${VERIFY_DIR}/merklane/prisma/migrations/0007_blockbee_referrals/migration.sql" ] && echo "  [ok]   archive: migration 0007 ships" \
  || { echo "  [FAIL] archive: prisma/migrations/0007_blockbee_referrals MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/src/lib/ads/blockbee.ts" ] && echo "  [ok]   archive: BlockBee client ships" \
  || { echo "  [FAIL] archive: src/lib/ads/blockbee.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/blockbee.ts" 'verifyWebhookSignature' \
  "archive: webhook signature verification ships"
[ -f "${VERIFY_DIR}/merklane/src/app/api/webhooks/blockbee/route.ts" ] && echo "  [ok]   archive: BlockBee webhook route ships" \
  || { echo "  [FAIL] archive: webhooks/blockbee/route.ts MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/src/lib/referral.ts" ] && echo "  [ok]   archive: referral lib ships" \
  || { echo "  [FAIL] archive: src/lib/referral.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/referral.ts" 'REFERRAL_RATE = 0.5' \
  "archive: 50% referral commission ships"
[ -f "${VERIFY_DIR}/merklane/scripts/test-blockbee-e2e.ts" ] && echo "  [ok]   archive: BlockBee e2e suite ships" \
  || { echo "  [FAIL] archive: scripts/test-blockbee-e2e.ts MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/scripts/run-blockbee-e2e.sh" ] && echo "  [ok]   archive: BlockBee e2e runner ships" \
  || { echo "  [FAIL] archive: scripts/run-blockbee-e2e.sh MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/webhooks/telegram-admin/route.ts" 'Manage team' \
  "archive: admin bot CMS menus ship"
[ ! -f "${VERIFY_DIR}/merklane/src/app/globals.legacy.css" ] && echo "  [ok]   archive: no stale globals.legacy.css (design rolled back)" \
  || { echo "  [FAIL] archive: globals.legacy.css still ships — restored as globals.css, must not ship twice"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/app/globals.css" 'original template design (restored' \
  "archive: legacy template design ships as the live stylesheet"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/ad-slot.tsx" 'SLOT_BASE' \
  "archive: ad slots styled via Tailwind utilities (legacy-safe)"
assert_file_contains "${VERIFY_DIR}/merklane/src/i18n/messages/ru.ts" 'adSlot: {' \
  "archive: ru dictionary carries the ads namespaces"
assert_file_contains "${VERIFY_DIR}/merklane/src/i18n/messages/ja.ts" 'adSlot: {' \
  "archive: ja dictionary carries the ads namespaces"
[ -f "${VERIFY_DIR}/merklane/scripts/test-ads-e2e.ts" ] && echo "  [ok]   archive: ads e2e suite ships" \
  || { echo "  [FAIL] archive: scripts/test-ads-e2e.ts MISSING"; archive_fail=1; }
# --- Premium subscriptions (in-archive mirror of the pre-flight checks) --------
[ -f "${VERIFY_DIR}/merklane/src/lib/premium/plan.ts" ] && echo "  [ok]   archive: premium plan catalog ships" \
  || { echo "  [FAIL] archive: src/lib/premium/plan.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/premium/plan.ts" 'monthlyCents: 500' \
  'archive: $5.00/month premium price ships'
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/premium/plan.ts" 'yearlyCents: 9000' \
  'archive: $90.00/year Premium+ price ships'
[ -f "${VERIFY_DIR}/merklane/src/lib/premium/orders.ts" ] && echo "  [ok]   archive: premium orders lib ships" \
  || { echo "  [FAIL] archive: src/lib/premium/orders.ts MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/src/app/api/premium/checkout/route.ts" ] && echo "  [ok]   archive: premium checkout route ships" \
  || { echo "  [FAIL] archive: api/premium/checkout/route.ts MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/src/app/api/premium/checkout/[id]/route.ts" ] && echo "  [ok]   archive: premium order polling route ships" \
  || { echo "  [FAIL] archive: api/premium/checkout/[id]/route.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/webhooks/blockbee/route.ts" 'isPremiumOrderId' \
  "archive: webhook distinguishes prem_/premplus_ from ads orders"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/bots/dispatch.ts" "plan: { in: ['premium', 'premium_plus'] }" \
  "archive: dispatch paywall ships (free users never alerted)"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/webhooks/telegram/route.ts" 'Job alerts are a Premium feature' \
  "archive: /alerts on paywall message ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/posts/route.ts" 'EDITORIAL_MONTHLY_QUOTA' \
  "archive: Premium+ editorial quota ships"
[ -f "${VERIFY_DIR}/merklane/prisma/migrations/0009_premium_orders/migration.sql" ] && echo "  [ok]   archive: migration 0009 ships" \
  || { echo "  [FAIL] archive: prisma/migrations/0009_premium_orders MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/scripts/test-premium-e2e.ts" ] && echo "  [ok]   archive: premium e2e suite ships" \
  || { echo "  [FAIL] archive: scripts/test-premium-e2e.ts MISSING"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/scripts/run-premium-e2e.sh" ] && echo "  [ok]   archive: premium e2e runner ships" \
  || { echo "  [FAIL] archive: scripts/run-premium-e2e.sh MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/i18n/messages/ru.ts" 'premium: {' \
  "archive: ru dictionary carries the premium namespace"
assert_file_contains "${VERIFY_DIR}/merklane/src/i18n/messages/ja.ts" 'premium: {' \
  "archive: ja dictionary carries the premium namespace"
archive_prem_i18n_ok=0
for dict in "${VERIFY_DIR}"/merklane/src/i18n/messages/*.ts; do
  if grep -q 'premium: {' "${dict}" && grep -q 'premiumActive:' "${dict}"; then
    archive_prem_i18n_ok=$((archive_prem_i18n_ok + 1))
  fi
done
[ "${archive_prem_i18n_ok}" -eq 20 ] && echo "  [ok]   archive: premium namespace in all 20 dictionaries" \
  || { echo "  [FAIL] archive: premium namespace in only ${archive_prem_i18n_ok}/20 dictionaries"; archive_fail=1; }

# --- Dynamic team CMS + visitor-stats geolocation (stage: team-cms + geo) ---
[ -f "${VERIFY_DIR}/merklane/prisma/migrations/0010_team_members/migration.sql" ] && echo "  [ok]   archive: migration 0010 (TeamMember) ships" \
  || { echo "  [FAIL] archive: prisma/migrations/0010_team_members MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/prisma/schema.prisma" 'model TeamMember' \
  "archive: TeamMember model ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/team.ts" 'getTeamMembers' \
  "archive: team CMS data layer ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/webhooks/telegram-admin/route.ts" 'teamadd' \
  "archive: bot add-member wizard ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/webhooks/telegram-admin/route.ts" 'mremove2' \
  "archive: bot member removal (two-tap confirm) ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/[locale]/about/page.tsx" 'getTeamMembers' \
  "archive: /about renders the team from the DB"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/rate-limit.ts" 'cf-connecting-ip' \
  "archive: clientIp prefers CF-Connecting-IP (true visitor IP)"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/stats/track.ts" 'cf-ipcountry' \
  "archive: stats country prefers cf-ipcountry (Cloudflare geo)"
[ -f "${VERIFY_DIR}/merklane/scripts/test-stats-geo.ts" ] && echo "  [ok]   archive: geolocation unit suite ships" \
  || { echo "  [FAIL] archive: scripts/test-stats-geo.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/scripts/test-admin-bot-e2e.ts" 'teamadd' \
  "archive: admin-bot e2e covers the team CMS"
# --- Ads Phase 1 (in-archive mirror) -------------------------------------------
for PHASE1_MODEL in Wallet LedgerEntry Campaign Creative BudgetReservation; do
  assert_file_contains "${VERIFY_DIR}/merklane/prisma/schema.prisma" "model ${PHASE1_MODEL} " \
    "archive: schema ${PHASE1_MODEL} model (PostgreSQL dialect)"
  assert_file_contains "${VERIFY_DIR}/merklane/prisma/schema.sqlite.prisma" "model ${PHASE1_MODEL} " \
    "archive: schema ${PHASE1_MODEL} model (SQLite preview dialect)"
done
[ -f "${VERIFY_DIR}/merklane/prisma/migrations/0011_ads_phase1_double_entry/migration.sql" ] && echo "  [ok]   archive: migration 0011_ads_phase1_double_entry present" \
  || { echo "  [FAIL] archive: prisma/migrations/0011_ads_phase1_double_entry MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/prisma/migrations/0011_ads_phase1_double_entry/migration.sql" "migrate:campaign:" \
  "archive: migration 0011 carries the deterministic legacy transform"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/money.ts" 'MICRO_PER_USD = 1_000_000' \
  "archive: money.ts micro-USD integer unit"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/wallet.ts" 'chargeReservation' \
  "archive: wallet.ts ledger transaction service"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/auction.ts" 'pickPoolAndDraw' \
  "archive: auction.ts 50/50 pool split"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/auction.ts" 'RESERVATION_TTL_MS = 30 * 60 * 1000' \
  "archive: auction.ts 30-minute hold TTL"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/click/[token]/route.ts" 'payload.r' \
  "archive: click route keyed by the signed reservation id"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/wallet/route.ts" 'ledger:' \
  "archive: wallet route exposes the ledger"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/ad-slot.tsx" "ad.format === 'banner'" \
  "archive: AdSlot banner format"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/ads-dashboard.tsx" 'formatBanner' \
  "archive: dashboard format chips"
if grep -q 'model AdCampaign' "${VERIFY_DIR}/merklane/prisma/schema.prisma" || grep -q 'model AdCampaign' "${VERIFY_DIR}/merklane/prisma/schema.sqlite.prisma"; then
  echo "  [FAIL] archive: pre-phase AdCampaign model still in a schema (stale bundle!)"
  archive_fail=1
else
  echo "  [ok]   archive: no pre-phase AdCampaign model in either schema"
fi
if grep -rEq 'adBalance|AdImpression|bidPerView' "${VERIFY_DIR}/merklane/src"; then
  echo "  [FAIL] archive: pre-phase ads references still in src/ (stale bundle!)"
  grep -rEn 'adBalance|AdImpression|bidPerView' "${VERIFY_DIR}/merklane/src" | head -5
  archive_fail=1
else
  echo "  [ok]   archive: no pre-phase ads references in src/"
fi
PHASE1_ARCHIVE_OK=0
PHASE1_ARCHIVE_COUNT="$(ls -1 "${VERIFY_DIR}/merklane/src/i18n/messages" | grep -c '\.ts$')"
for PHASE1_ARCHIVE_FILE in "${VERIFY_DIR}"/merklane/src/i18n/messages/*.ts; do
  if grep -q "bidSuffixCpc:" "${PHASE1_ARCHIVE_FILE}" && grep -q "ledgerTitle:" "${PHASE1_ARCHIVE_FILE}"; then
    PHASE1_ARCHIVE_OK=$((PHASE1_ARCHIVE_OK + 1))
  else
    echo "  [FAIL] archive: ${PHASE1_ARCHIVE_FILE##*/} missing Phase-1 ads keys"
    archive_fail=1
  fi
done
[ "${PHASE1_ARCHIVE_OK}" -eq "${PHASE1_ARCHIVE_COUNT}" ] && echo "  [ok]   archive: Phase-1 ads keys in ${PHASE1_ARCHIVE_OK}/${PHASE1_ARCHIVE_COUNT} dictionaries" \
  || { echo "  [FAIL] archive: Phase-1 ads keys only ${PHASE1_ARCHIVE_OK}/${PHASE1_ARCHIVE_COUNT}"; archive_fail=1; }
[ -f "${VERIFY_DIR}/merklane/scripts/apply-migration-sql.ts" ] && echo "  [ok]   archive: local migration applier ships" \
  || { echo "  [FAIL] archive: scripts/apply-migration-sql.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/scripts/test-ads-e2e.ts" 'ledgerInvariant' \
  "archive: ads e2e carries the ledger invariant check"
# --- Ads Phase 2 (in-archive mirror) -------------------------------------------
if [ -f "${VERIFY_DIR}/merklane/src/app/api/ads/assets/upload/route.ts" ]; then
  echo "  [ok]   archive: banner upload route ships (src/app/api/ads/assets/upload)"
else
  echo "  [FAIL] archive: src/app/api/ads/assets/upload/route.ts MISSING" >&2
  echo "         (an rsync exclude pattern stripped it — anchor the excludes!)" >&2
  archive_fail=1
fi
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/assets/upload/route.ts" 'MAX_BYTES = 1_572_864' \
  "archive: upload route 1.5 MB cap"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/assets/upload/route.ts" 'sniffImageType' \
  "archive: upload route magic-byte sniffing"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/assets/upload/route.ts" "'/uploads/ads'" \
  "archive: upload route local storage prefix"
[ -f "${VERIFY_DIR}/merklane/src/components/site/ads/campaign-wizard.tsx" ] && echo "  [ok]   archive: campaign wizard ships" \
  || { echo "  [FAIL] archive: campaign-wizard.tsx MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/campaign-wizard.tsx" 'TOTAL_STEPS = 5' \
  "archive: wizard is the 5-step flow"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/campaign-wizard.tsx" 'wizardStepOf' \
  "archive: wizard progress bar (Step N of 5)"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/campaign-wizard.tsx" 'btnSaveDraft' \
  "archive: wizard save-as-draft"
[ -f "${VERIFY_DIR}/merklane/src/lib/ads/moderation.ts" ] && echo "  [ok]   archive: moderation state machine ships" \
  || { echo "  [FAIL] archive: src/lib/ads/moderation.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/moderation.ts" 'submitCampaignForReview' \
  "archive: submit-for-review (DRAFT/REJECTED → PENDING)"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/moderation.ts" 'rejectCampaign' \
  "archive: reject-with-reason (→ REJECTED)"
[ -f "${VERIFY_DIR}/merklane/src/lib/ads/targeting.ts" ] && echo "  [ok]   archive: targeting matcher ships" \
  || { echo "  [FAIL] archive: src/lib/ads/targeting.ts MISSING"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/targeting.ts" 'targetingMatches' \
  "archive: targeting matcher"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/webhooks/telegram-admin/route.ts" '🛡 Moderation Queue' \
  "archive: admin bot moderation queue menu"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/webhooks/telegram-admin/route.ts" 'modok:' \
  "archive: admin bot approve button"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/webhooks/telegram-admin/route.ts" 'modno:' \
  "archive: admin bot reject button"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/webhooks/telegram-admin/route.ts" 'reject-reason' \
  "archive: admin bot rejection reason capture"
[ -f "${VERIFY_DIR}/merklane/prisma/migrations/0012_ads_phase2_targeting_moderation/migration.sql" ] && echo "  [ok]   archive: migration 0012 ships" \
  || { echo "  [FAIL] archive: migration 0012 MISSING"; archive_fail=1; }
for PHASE2_ARCHIVE_COL in targetKeywords keywordMatch countryMode targetHashtags; do
  assert_file_contains "${VERIFY_DIR}/merklane/prisma/schema.prisma" "${PHASE2_ARCHIVE_COL} " \
    "archive: schema (pg) Campaign.${PHASE2_ARCHIVE_COL}"
  assert_file_contains "${VERIFY_DIR}/merklane/prisma/schema.sqlite.prisma" "${PHASE2_ARCHIVE_COL} " \
    "archive: schema (sqlite) Campaign.${PHASE2_ARCHIVE_COL}"
done
archive_phase2_i18n_ok=0
for dict in "${VERIFY_DIR}"/merklane/src/i18n/messages/*.ts; do
  if grep -q "wizardStepOf:" "${dict}" && grep -q "btnSaveDraft:" "${dict}" && grep -q "countryModeInclude:" "${dict}"; then
    archive_phase2_i18n_ok=$((archive_phase2_i18n_ok + 1))
  fi
done
[ "${archive_phase2_i18n_ok}" -eq 20 ] && echo "  [ok]   archive: Phase-2 wizard keys in all 20 dictionaries" \
  || { echo "  [FAIL] archive: Phase-2 wizard keys in only ${archive_phase2_i18n_ok}/20 dictionaries"; archive_fail=1; }
assert_file_contains "${VERIFY_DIR}/merklane/scripts/test-ads-e2e.ts" 'Phase 2' \
  "archive: ads e2e is the Phase-2 suite"
# The exact regression the last stale bundle shipped, probed the way a
# downstream verifier would probe the extracted tree (grep -r, not -F):
if grep -rq "wizard" "${VERIFY_DIR}/merklane/src/components/site/" \
  && grep -rq "Moderation Queue" "${VERIFY_DIR}/merklane/src/" \
  && grep -rq "PENDING" "${VERIFY_DIR}/merklane/src/lib/ads/" \
  && grep -rq "magic-byte" "${VERIFY_DIR}/merklane/src/"; then
  echo "  [ok]   archive: Phase-2 landmarks greppable (wizard / Moderation Queue / PENDING / magic-byte)"
else
  echo "  [FAIL] archive: Phase-2 landmarks not greppable — stale or partial bundle" >&2
  archive_fail=1
fi
# upload route reachable by name search, mirroring find -name '*upload*'
if [ -n "$(find "${VERIFY_DIR}/merklane/src/app/api" -name '*upload*' -type d)" ]; then
  echo "  [ok]   archive: upload directories findable under src/app/api"
else
  echo "  [FAIL] archive: find src/app/api -name '*upload*' is empty — exclude bug" >&2
  archive_fail=1
fi
# --- Ads Phase 3 (in-archive mirror) -------------------------------------------
for PHASE3_ARCHIVE_FILE in \
  "src/lib/ads/tokens.ts" \
  "src/lib/ads/events.ts" \
  "src/lib/ads/antifraud.ts" \
  "src/lib/ads/reporting.ts" \
  "src/lib/ads/report-format.ts" \
  "src/app/api/ads/click/[token]/route.ts" \
  "src/app/api/ads/event/route.ts" \
  "src/app/api/ads/reports/route.ts" \
  "src/app/api/ads/reports/export/route.ts" \
  "src/components/site/ads/ads-reports.tsx" \
  "prisma/migrations/0013_ads_phase3_events/migration.sql" \
  "scripts/test-ads-events-e2e.ts" \
  "scripts/run-ads-events-e2e.sh"; do
  if [ -f "${VERIFY_DIR}/merklane/${PHASE3_ARCHIVE_FILE}" ]; then
    echo "  [ok]   archive: ${PHASE3_ARCHIVE_FILE} ships"
  else
    echo "  [FAIL] archive: ${PHASE3_ARCHIVE_FILE} MISSING" >&2
    archive_fail=1
  fi
done
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/click/[token]/route.ts" 'verifyAdToken' \
  "archive: click route validates the HMAC token"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/click/[token]/route.ts" "status: 302" \
  "archive: click route redirects to the signed destination"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/event/route.ts" 'EVENT_RATE_LIMIT' \
  "archive: event endpoint rate limited"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/event/route.ts" 'finalizeView' \
  "archive: viewable impression is the only CPM billing event"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/serve/route.ts" 'isKnownBot' \
  "archive: serve route blocks bots before the auction"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/auction.ts" "eventType: 'loaded_impression'" \
  "archive: serve logs loaded_impression server-side"
if grep -qF "ChargeGuardFailed" "${VERIFY_DIR}/merklane/src/lib/ads/auction.ts" 2>/dev/null; then
  echo "  [FAIL] archive: auction.ts still charges CPM at serve time (Phase-1 leftover)" >&2
  archive_fail=1
else
  echo "  [ok]   archive: no charge at serve time — validated events only"
fi
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/ad-slot.tsx" 'IntersectionObserver' \
  "archive: AdSlot measures viewability (≥ 50 %)"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/ad-slot.tsx" 'visibilitychange' \
  "archive: AdSlot honours the active-tab requirement"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/ad-slot.tsx" "VIEWABLE_MS" \
  "archive: AdSlot one-continuous-second timer"
assert_file_contains "${VERIFY_DIR}/merklane/src/app/api/ads/reports/export/route.ts" 'sanitizeCsvCell' \
  "archive: CSV export formula-injection guard"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/report-format.ts" "NO_DATA = '—'" \
  "archive: em dash for no-data metrics"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/ads-dashboard.tsx" "tabReports" \
  "archive: dashboard third tab (Reports)"
archive_phase3_i18n_ok=0
for dict in "${VERIFY_DIR}"/merklane/src/i18n/messages/*.ts; do
  if grep -q "tabReports:" "${dict}" && grep -q "downloadCsv:" "${dict}" && grep -q "colEcpc:" "${dict}"; then
    archive_phase3_i18n_ok=$((archive_phase3_i18n_ok + 1))
  fi
done
[ "${archive_phase3_i18n_ok}" -eq 20 ] && echo "  [ok]   archive: Phase-3 reports keys in all 20 dictionaries" \
  || { echo "  [FAIL] archive: Phase-3 reports keys in only ${archive_phase3_i18n_ok}/20 dictionaries"; archive_fail=1; }
# Phase-3 landmarks, greppable the way a downstream verifier would:
if grep -rq "viewable_impression" "${VERIFY_DIR}/merklane/src/" \
  && grep -rq "IntersectionObserver" "${VERIFY_DIR}/merklane/src/" \
  && grep -rq "sanitizeCsvCell" "${VERIFY_DIR}/merklane/src/" \
  && grep -rq "isKnownBot" "${VERIFY_DIR}/merklane/src/"; then
  echo "  [ok]   archive: Phase-3 landmarks greppable (viewable_impression / IntersectionObserver / sanitizeCsvCell / isKnownBot)"
else
  echo "  [FAIL] archive: Phase-3 landmarks not greppable — stale or partial bundle" >&2
  archive_fail=1
fi
# --- Ads Phase 4 in-archive mirror --------------------------------------
for PHASE4_ARCHIVE_FILE in \
  "prisma/migrations/0014_ads_phase4_abtest_forecast_audit/migration.sql" \
  "src/lib/ads/experiments.ts" \
  "src/lib/ads/forecast.ts" \
  "src/lib/ads/permissions.ts" \
  "src/lib/ads/audit.ts" \
  "src/app/api/ads/campaigns/[id]/experiments/route.ts" \
  "src/app/api/ads/experiments/[id]/route.ts" \
  "src/app/api/ads/forecast/route.ts" \
  "src/app/api/admin/audit-log/route.ts" \
  "src/app/api/admin/users/role/route.ts" \
  "src/components/site/ads/ab-testing.tsx"; do
  if [ -f "${VERIFY_DIR}/merklane/${PHASE4_ARCHIVE_FILE}" ]; then
    echo "  [ok]   archive: ${PHASE4_ARCHIVE_FILE} ships"
  else
    echo "  [FAIL] archive: ${PHASE4_ARCHIVE_FILE} MISSING" >&2
    archive_fail=1
  fi
done
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/experiments.ts" 'twoProportionZTest' \
  "archive: the z-test ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/auction.ts" 'variantForVisitor' \
  "archive: the A/B variant is chosen after the draw"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/forecast.ts" 'FORECAST_MIN_PLATFORM_IMPRESSIONS' \
  "archive: the forecast honesty gate ships"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/permissions.ts" 'canViewReports' \
  "archive: the permission tiers ship"
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/ads/moderation.ts" 'REJECT_CAMPAIGN' \
  "archive: moderation decisions land in the AuditLog"
assert_file_contains "${VERIFY_DIR}/merklane/src/components/site/ads/campaign-wizard.tsx" 'forecastInsufficient' \
  "archive: wizard Step 4 forecast fallback ships"
archive_phase4_i18n_ok=0
for dict in "${VERIFY_DIR}"/merklane/src/i18n/messages/*.ts; do
  if grep -q "abTab:" "${dict}" && grep -q "forecastInsufficient:" "${dict}"; then
    archive_phase4_i18n_ok=$((archive_phase4_i18n_ok + 1))
  fi
done
[ "${archive_phase4_i18n_ok}" -eq 20 ] && echo "  [ok]   archive: Phase-4 keys in all 20 dictionaries" \
  || { echo "  [FAIL] archive: Phase-4 keys in only ${archive_phase4_i18n_ok}/20 dictionaries"; archive_fail=1; }
# Phase-4 landmarks, greppable the way a downstream verifier would:
if grep -rq "variantForVisitor" "${VERIFY_DIR}/merklane/src/" \
  && grep -rq "Insufficient data to forecast" "${VERIFY_DIR}/merklane/src/" \
  && grep -rq "forbidden_role" "${VERIFY_DIR}/merklane/src/" \
  && grep -rq "APPROVE_CAMPAIGN" "${VERIFY_DIR}/merklane/src/"; then
  echo "  [ok]   archive: Phase-4 landmarks greppable (variantForVisitor / forecast fallback / forbidden_role / APPROVE_CAMPAIGN)"
else
  echo "  [FAIL] archive: Phase-4 landmarks not greppable — stale or partial bundle" >&2
  archive_fail=1
fi
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
