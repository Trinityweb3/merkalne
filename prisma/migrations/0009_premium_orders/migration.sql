-- Premium subscriptions: BlockBee checkout orders for Premium & Premium+.
--
-- PremiumOrder stores one checkout intention per row. The row id IS the
-- BlockBee order_id and carries the routing prefix the IPN webhook keys on:
--   prem_<m|y>_<userId>_<rand>      → Premium   ($5/month · $30/year)
--   premplus_<m|y>_<userId>_<rand>  → Premium+  ($15/month · $90/year)
-- plan / period / days / amountExpected are persisted per row so the webhook
-- never trusts the prefix string beyond routing. Confirmation flips the
-- status atomically (updateMany guard) and extends User.plan/premiumUntil
-- exactly once. Money stays INTEGER US cents (portable, no floats).

-- CreateTable
CREATE TABLE "PremiumOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "amountExpected" INTEGER NOT NULL,
    "amountReceived" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'blockbee',
    "coin" TEXT,
    "callbackNonce" TEXT,
    "uuid" TEXT,
    "txHash" TEXT,
    "paidCoinAmount" TEXT,
    "coinPriceUsd" TEXT,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "PremiumOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PremiumOrder_uuid_key" ON "PremiumOrder"("uuid");

-- CreateIndex
CREATE INDEX "PremiumOrder_userId_status_idx" ON "PremiumOrder"("userId", "status");
CREATE INDEX "PremiumOrder_status_createdAt_idx" ON "PremiumOrder"("status", "createdAt");
CREATE INDEX "PremiumOrder_provider_status_idx" ON "PremiumOrder"("provider", "status");

-- AddForeignKey
ALTER TABLE "PremiumOrder" ADD CONSTRAINT "PremiumOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
