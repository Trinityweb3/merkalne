-- Merklane Ads Phase 1 — double-entry accounting, unified wallet, campaign
-- structure, budget reservations.
--
-- This migration REPLACES the pre-phase ads models:
--   User.adBalance (cents)      → Wallet.availableMicroUsd / reservedMicroUsd
--                                 (1 cent = 10_000 micro-USD; $1.00 = 1_000_000)
--   AdCampaign (cents, per-view) → Campaign (micro-USD, cpc|cpm, text|banner)
--                                 + Creative (versioned content)
--   AdImpression (view/click log) → BudgetReservation (held|finalized|expired)
--                                 — every billable event is a reservation, and
--                                 spend lives in the LedgerEntry CHARGE rows.
--
-- DATA TRANSFORMATION (idempotent by construction — the new tables are empty
-- when this runs, and every transformed row carries a deterministic id, so
-- the same migration applied to a database that already went through it
-- inserts nothing):
--
--   wallets     one Wallet per user who had adBalance > 0 OR owned campaigns
--               (available = adBalance * 10_000, opening CREDIT ledger entry
--               eventId 'migrate:wallet:<userId>' — written only when
--               adBalance > 0, zero-credits are noise)
--   campaigns   every AdCampaign becomes a Campaign, keeping its id:
--                 format 'text', billingModel 'cpm' (the old system billed
--                 per served view — the faithful conversion is
--                 bidPerView * 1000 in cents = bidPerView * 10_000_000 µUSD),
--                 status 'ended' → 'completed', totalBudget = old balance,
--                 dailyBudget 0 (the old system had no daily cap)
--   creatives   one v1 APPROVED Creative per campaign (old title/body/ctaUrl)
--   budget      each campaign's old balance is committed to it: a RESERVE
--               ledger entry (eventId 'migrate:campaign:<id>') and
--               Wallet.reserved += balance * 10_000. Ended campaigns keep
--               their budget reserved — the advertiser recovers it by
--               deleting the campaign in the dashboard (refund flow).
--
-- NOT migrated (deliberate): AdImpression view/click history — the new
-- system counts served/clicks from BudgetReservation rows, so per-campaign
-- statistics restart at the migration. All rows in the local/production
-- databases are QA-era data.
--
-- Every statement in this file is valid on BOTH PostgreSQL (prisma migrate
-- deploy in production) and SQLite (scripts/apply-migration-sql.ts for the
-- local preview) — see the header of prisma/schema.prisma for the
-- portability rules.

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "availableMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "reservedMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable (foreign keys are declared inline — portable across PostgreSQL
-- and SQLite; SQLite has no ALTER TABLE … ADD CONSTRAINT)
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountMicroUsd" INTEGER NOT NULL,
    "campaignId" TEXT,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'text',
    "billingModel" TEXT NOT NULL DEFAULT 'cpc',
    "bidMicroUsd" INTEGER NOT NULL,
    "dailyBudgetMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "totalBudgetMicroUsd" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deletedAt" TIMESTAMP(3),
    "targetSections" TEXT NOT NULL DEFAULT '',
    "targetLocales" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Campaign_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Creative" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "imageUrl" TEXT,
    "targetUrl" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "moderationStatus" TEXT NOT NULL DEFAULT 'approved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Creative_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Creative_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BudgetReservation" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "amountMicroUsd" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BudgetReservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BudgetReservation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_eventId_key" ON "LedgerEntry"("eventId");

-- CreateIndex
CREATE INDEX "LedgerEntry_walletId_createdAt_idx" ON "LedgerEntry"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_campaignId_createdAt_idx" ON "LedgerEntry"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_status_deletedAt_idx" ON "Campaign"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "Campaign_advertiserId_createdAt_idx" ON "Campaign"("advertiserId", "createdAt");

-- CreateIndex
CREATE INDEX "Creative_campaignId_version_idx" ON "Creative"("campaignId", "version");

-- CreateIndex
CREATE INDEX "BudgetReservation_campaignId_status_idx" ON "BudgetReservation"("campaignId", "status");

-- CreateIndex
CREATE INDEX "BudgetReservation_status_expiresAt_idx" ON "BudgetReservation"("status", "expiresAt");

-- ---------------------------------------------------------------------
-- Data transformation (see the header comment). Deterministic ids keep
-- every step idempotent; the WHERE clauses are no-ops on databases that
-- have no legacy ads data.
-- ---------------------------------------------------------------------

-- One wallet per user who had a balance or owned campaigns.
INSERT INTO "Wallet" ("id", "userId", "availableMicroUsd", "reservedMicroUsd", "createdAt", "updatedAt")
SELECT 'w_' || u."id", u."id", u."adBalance" * 10000, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User" u
WHERE u."adBalance" > 0
   OR EXISTS (SELECT 1 FROM "AdCampaign" c WHERE c."advertiserId" = u."id");

-- Opening credit for the migrated wallet balance (eventId is unique — a
-- re-run inserts nothing; zero balances skip the row entirely).
INSERT INTO "LedgerEntry" ("id", "walletId", "type", "amountMicroUsd", "campaignId", "eventId", "createdAt")
SELECT 'l_w_' || u."id", 'w_' || u."id", 'credit', u."adBalance" * 10000, NULL,
       'migrate:wallet:' || u."id", CURRENT_TIMESTAMP
FROM "User" u
WHERE u."adBalance" > 0;

-- Campaigns: old per-view billing → CPM (bid = per-view price × 1000).
INSERT INTO "Campaign" ("id", "advertiserId", "name", "format", "billingModel", "bidMicroUsd",
                        "dailyBudgetMicroUsd", "totalBudgetMicroUsd", "status", "deletedAt",
                        "targetSections", "targetLocales", "createdAt", "updatedAt")
SELECT c."id", c."advertiserId", c."title", 'text', 'cpm', c."bidPerView" * 10000000,
       0, c."balance" * 10000,
       CASE WHEN c."status" = 'ended' THEN 'completed' ELSE c."status" END,
       NULL, c."targetSections", c."targetLocales", c."createdAt", c."updatedAt"
FROM "AdCampaign" c;

-- One v1 approved creative per campaign (old ads were text cards).
INSERT INTO "Creative" ("id", "campaignId", "title", "body", "imageUrl", "targetUrl", "version", "moderationStatus", "createdAt")
SELECT 'cr_' || c."id", c."id", c."title", c."body", NULL, c."ctaUrl", 1, 'approved', c."createdAt"
FROM "AdCampaign" c;

-- Commit each campaign's old balance to it (reserve entries; skipped for
-- drained campaigns — a zero reservation is noise).
INSERT INTO "LedgerEntry" ("id", "walletId", "type", "amountMicroUsd", "campaignId", "eventId", "createdAt")
SELECT 'l_c_' || c."id", 'w_' || c."advertiserId", 'reserve', -(c."balance" * 10000), c."id",
       'migrate:campaign:' || c."id", c."createdAt"
FROM "AdCampaign" c
WHERE c."balance" > 0;

-- The reserved bucket mirrors the sum of committed campaign budgets.
UPDATE "Wallet"
SET "reservedMicroUsd" = COALESCE(
      (SELECT SUM(c."balance") FROM "AdCampaign" c WHERE c."advertiserId" = "Wallet"."userId"),
      0
    ) * 10000,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "reservedMicroUsd" = 0;

-- ---------------------------------------------------------------------
-- Legacy teardown. Order matters: CryptoTopUp.campaignId goes first (its
-- FK pointed at AdCampaign), then the child table AdImpression, then
-- AdCampaign itself.
-- ---------------------------------------------------------------------

-- CryptoTopUp.campaignId (deprecated + ignored since the wallet-first
-- refactor, nullable) is dropped with the portable recreate dance —
-- SQLite cannot ALTER TABLE … ADD/DROP CONSTRAINT, and its DROP COLUMN
-- refuses a column named in a foreign key, so the one syntax that works
-- on BOTH engines is: new table → copy → drop old → rename → indexes.
CREATE TABLE "CryptoTopUp_new" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "amountExpected" INTEGER NOT NULL,
    "amountReceived" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "coin" TEXT,
    "callbackNonce" TEXT,
    "uuid" TEXT,
    "txHash" TEXT,
    "paidCoinAmount" TEXT,
    "coinPriceUsd" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "CryptoTopUp_new_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CryptoTopUp_new_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "CryptoTopUp_new"
  ("id", "advertiserId", "walletAddress", "amountExpected", "amountReceived", "status",
   "provider", "coin", "callbackNonce", "uuid", "txHash", "paidCoinAmount", "coinPriceUsd",
   "createdAt", "confirmedAt")
SELECT
  "id", "advertiserId", "walletAddress", "amountExpected", "amountReceived", "status",
  "provider", "coin", "callbackNonce", "uuid", "txHash", "paidCoinAmount", "coinPriceUsd",
  "createdAt", "confirmedAt"
FROM "CryptoTopUp";

DROP TABLE "CryptoTopUp";
ALTER TABLE "CryptoTopUp_new" RENAME TO "CryptoTopUp";

-- CreateIndex (recreated for the renamed table — the originals died with it)
CREATE UNIQUE INDEX "CryptoTopUp_uuid_key" ON "CryptoTopUp"("uuid");
CREATE INDEX "CryptoTopUp_advertiserId_status_idx" ON "CryptoTopUp"("advertiserId", "status");
CREATE INDEX "CryptoTopUp_status_createdAt_idx" ON "CryptoTopUp"("status", "createdAt");
CREATE INDEX "CryptoTopUp_provider_status_idx" ON "CryptoTopUp"("provider", "status");

-- AlterTable: the wallet balance lives in Wallet.availableMicroUsd now
ALTER TABLE "User" DROP COLUMN "adBalance";

-- DropTable: impression/click history is superseded by BudgetReservation
DROP TABLE IF EXISTS "AdImpression";

-- DropTable: superseded by Campaign + Creative + BudgetReservation
DROP TABLE IF EXISTS "AdCampaign";
