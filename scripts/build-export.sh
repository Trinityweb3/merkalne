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
# --- Team data + social links (Vazima / Trinity / Grobofhik) ------------------
assert_file_contains "${ROOT}/src/lib/about-content.ts" 'SOCIAL_VAZIMA_URL' \
  "about-content: Vazima social link read from env"
assert_file_contains "${ROOT}/src/lib/about-content.ts" 'SOCIAL_TRINITY_URL' \
  "about-content: Trinity social link read from env"
assert_file_contains "${ROOT}/src/lib/about-content.ts" 'SOCIAL_GROBOFHIK_URL' \
  "about-content: Grobofhik social link read from env"
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
assert_file_contains "${ROOT}/prisma/schema.prisma" 'model AdCampaign' \
  "schema: AdCampaign model"
assert_file_contains "${ROOT}/prisma/schema.prisma" 'model AdImpression' \
  "schema: AdImpression ledger"
assert_file_contains "${ROOT}/prisma/schema.prisma" 'model CryptoTopUp' \
  "schema: CryptoTopUp model"
[ -f "${ROOT}/prisma/migrations/0006_site_cms_ads/migration.sql" ] && echo "  [ok]   migration 0006_site_cms_ads present" \
  || { echo "  [FAIL] prisma/migrations/0006_site_cms_ads missing"; fail=1; }
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'pickWeightedRandom' \
  "auction.ts: weighted-random (roulette wheel) selection"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" 'balance: { gte: drawn.bidPerView }' \
  "auction.ts: atomic conditional bill (no overdraft)"
assert_file_contains "${ROOT}/src/lib/ads/auction.ts" "status: 'paused'" \
  "auction.ts: drained campaigns auto-pause"
assert_file_contains "${ROOT}/src/lib/ads/topup.ts" 'deriveDepositAddress' \
  "topup.ts: deterministic deposit-address derivation (manual fallback)"
assert_file_contains "${ROOT}/src/lib/ads/topup.ts" 'confirmTopUp' \
  "topup.ts: idempotent confirmation + crediting"
assert_file_contains "${ROOT}/src/lib/ads/topup.ts" "blockbeeConfigured() ? 'blockbee' : 'manual'" \
  "topup.ts: AUTO mode resolution (blockbee when key set, else manual)"
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
assert_file_contains "${ROOT}/src/app/[locale]/ads/page.tsx" "redirect('/auth?mode=login&next=/ads')" \
  "/ads dashboard: auth-gated like the profile cabinet"
assert_file_contains "${ROOT}/src/app/api/ads/serve/route.ts" 'status: 204' \
  "serve API: 204 when nothing eligible (no empty boxes)"
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
assert_file_contains "${ROOT}/src/app/[locale]/about/page.tsx" 'getSiteOverrides' \
  "about page: dynamic team/logo from SiteSettings"
assert_file_contains "${ROOT}/src/app/[locale]/about/page.tsx" 'object-contain' \
  "about page: operator logo block (legacy-safe Tailwind classes)"
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
assert_file_contains "${VERIFY_DIR}/merklane/src/lib/about-content.ts" 'SOCIAL_VAZIMA_URL' \
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
