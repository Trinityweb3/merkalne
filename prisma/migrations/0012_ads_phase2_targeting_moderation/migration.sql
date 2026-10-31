-- Merklane Ads Phase 2 — wizard, banner uploads, advanced targeting and the
-- moderation lifecycle (DRAFT → PENDING → APPROVED / REJECTED).
--
-- Pure additive DDL — no data transformation, so it is safe to run on any
-- database that already went through 0011_ads_phase1_double_entry:
--
--   Campaign (targeting — normalised CSV columns, see the schema comment):
--     targetKeywords   lowercase keyword phrases; empty = site-wide
--     keywordMatch     "phrase" (default) | "exact" — how keywords match the
--                      page's keyword context (title + tags)
--     countryMode      "all" (default) | "include" | "exclude"
--     targetCountries  ISO 3166-1 alpha-2 codes, uppercase; empty = all
--     targetHashtags   lowercase hashtags without "#"; empty = no restriction
--
--   Creative (banner uploads + moderation):
--     altText          banner accessibility label
--     displayDomain    optional friendly host rendered on the card
--     moderationNote   moderator's rejection reason (status "rejected")
--
-- Existing rows keep serving unchanged: every new column defaults to "no
-- restriction" (keywords/countries/hashtags empty, mode "all"/"phrase") and
-- existing creatives keep whatever moderationStatus they already had
-- (approved ones keep serving; the new default "draft" only applies to
-- rows created after this migration).
--
-- Every statement is valid on BOTH PostgreSQL (prisma migrate deploy) and
-- SQLite (scripts/apply-migration-sql.ts) — see prisma/schema.prisma header.

-- AlterTable: advanced targeting on Campaign
ALTER TABLE "Campaign" ADD COLUMN "targetKeywords" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Campaign" ADD COLUMN "keywordMatch" TEXT NOT NULL DEFAULT 'phrase';
ALTER TABLE "Campaign" ADD COLUMN "countryMode" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "Campaign" ADD COLUMN "targetCountries" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Campaign" ADD COLUMN "targetHashtags" TEXT NOT NULL DEFAULT '';

-- AlterTable: banner upload fields + moderation note on Creative
ALTER TABLE "Creative" ADD COLUMN "altText" TEXT;
ALTER TABLE "Creative" ADD COLUMN "displayDomain" TEXT;
ALTER TABLE "Creative" ADD COLUMN "moderationNote" TEXT;
