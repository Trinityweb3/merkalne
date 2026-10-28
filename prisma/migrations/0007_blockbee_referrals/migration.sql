-- BlockBee payment processor + referral system with 50% commissions.
--
-- User: referral code (nullable only for legacy rows, backfilled lazily),
-- self-relation referredById (write-once at registration), referralBalance
-- in US cents. CryptoTopUp: provider/coin/nonce/uuid/txHash snapshot columns
-- for the BlockBee IPN flow. Two new tables: PaymentLog (append-only audit
-- trail for every payment event) and ReferralWithdrawal (BlockBee payout
-- requests; the balance is deducted only when the payout is confirmed).
-- Money stays INTEGER US cents — portable across PostgreSQL and SQLite.

-- AlterTable: User referral fields
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "User" ADD COLUMN "referredById" TEXT;
ALTER TABLE "User" ADD COLUMN "referralBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: CryptoTopUp BlockBee columns
ALTER TABLE "CryptoTopUp" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "CryptoTopUp" ADD COLUMN "coin" TEXT;
ALTER TABLE "CryptoTopUp" ADD COLUMN "callbackNonce" TEXT;
ALTER TABLE "CryptoTopUp" ADD COLUMN "uuid" TEXT;
ALTER TABLE "CryptoTopUp" ADD COLUMN "txHash" TEXT;
ALTER TABLE "CryptoTopUp" ADD COLUMN "paidCoinAmount" TEXT;
ALTER TABLE "CryptoTopUp" ADD COLUMN "coinPriceUsd" TEXT;

-- CreateTable: PaymentLog
CREATE TABLE "PaymentLog" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "externalId" TEXT,
    "referenceId" TEXT,
    "userId" TEXT,
    "amountCents" INTEGER,
    "detail" JSON,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReferralWithdrawal
CREATE TABLE "ReferralWithdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "coin" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "coinAmount" TEXT,
    "payoutRequestId" TEXT,
    "payoutId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ReferralWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_referredById_idx" ON "User"("referredById");

-- CreateIndex
CREATE INDEX "CryptoTopUp_provider_status_idx" ON "CryptoTopUp"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoTopUp_uuid_key" ON "CryptoTopUp"("uuid");

-- CreateIndex
CREATE INDEX "PaymentLog_source_createdAt_idx" ON "PaymentLog"("source", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentLog_referenceId_idx" ON "PaymentLog"("referenceId");

-- CreateIndex
CREATE INDEX "PaymentLog_externalId_idx" ON "PaymentLog"("externalId");

-- CreateIndex
CREATE INDEX "ReferralWithdrawal_userId_status_idx" ON "ReferralWithdrawal"("userId", "status");

-- CreateIndex
CREATE INDEX "ReferralWithdrawal_status_createdAt_idx" ON "ReferralWithdrawal"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralWithdrawal_payoutId_key" ON "ReferralWithdrawal"("payoutId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralWithdrawal" ADD CONSTRAINT "ReferralWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
