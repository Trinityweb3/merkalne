-- Ads UX restructure: advertiser wallet + campaign targeting.
--
-- User.adBalance: the advertiser WALLET in US cents. Crypto deposits
-- (BlockBee IPN → confirmTopUp) credit the wallet first; campaign budgets
-- are allocated from it at creation / "add funds" time. Existing campaign
-- balances are NOT migrated — they remain spendable flight budgets and are
-- surfaced as "In campaigns" in the wallet UI.
--
-- AdCampaign.targetSections / targetLocales: comma-separated targeting
-- lists (CSV — the schema deliberately avoids scalar lists for SQLite
-- portability). Empty string = match all sections / all languages; the
-- auction engine filters active campaigns against the serving page's
-- section slug and interface locale.
-- Money stays INTEGER US cents — portable across PostgreSQL and SQLite.

-- AlterTable: User advertiser wallet
ALTER TABLE "User" ADD COLUMN "adBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: AdCampaign targeting (CSV lists, empty = no restriction)
ALTER TABLE "AdCampaign" ADD COLUMN "targetSections" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AdCampaign" ADD COLUMN "targetLocales" TEXT NOT NULL DEFAULT '';
