-- Merklane Ads Phase 3 — the event pipeline (viewability measurement,
-- secure click redirects, anti-fraud) and the reporting layer.
--
--   AdEvent (NEW TABLE): the delivery log. loaded_impression,
--   viewable_impression and valid_click are recorded as SEPARATE rows per
--   BudgetReservation; the UNIQUE ("reservationId", "eventType") index is
--   the exactly-once guard — a double click, a replayed viewability beacon
--   or a bot retrying the event inserts at most one row (P2002 → treated
--   as a duplicate; the charge itself can never repeat: it is guarded by
--   the reservation's conditional status flip + the unique ledger eventId
--   charge:<reservationId>).
--
-- No existing table is altered: Phase 3 reuses the Phase 1
-- BudgetReservation lifecycle (held → finalized | expired) unchanged.
-- The billing shift (CPM serves now create HELD rows instead of
-- FINALIZED-at-serve; the charge moves to the validated viewable
-- impression event, exactly like CPC charges on a validated click) is
-- application logic in src/lib/ads/auction.ts, not DDL — existing rows
-- keep whatever status they already had.
--
-- Every statement is valid on BOTH PostgreSQL (prisma migrate deploy) and
-- SQLite (scripts/apply-migration-sql.ts) — see prisma/schema.prisma header.

-- CreateTable: AdEvent
-- (foreign key inline, the 0011 convention — valid on both PostgreSQL and
--  SQLite; SQLite has no ALTER TABLE … ADD CONSTRAINT)
CREATE TABLE "AdEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "slot" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: the exactly-once event guard (dedup per reservation+type)
CREATE UNIQUE INDEX "AdEvent_reservationId_eventType_key" ON "AdEvent"("reservationId", "eventType");

-- CreateIndex: reporting aggregation path (per campaign, per funnel stage)
CREATE INDEX "AdEvent_campaignId_eventType_createdAt_idx" ON "AdEvent"("campaignId", "eventType", "createdAt");

-- CreateIndex: campaign timeline (Reports tab, chronological lists)
CREATE INDEX "AdEvent_campaignId_createdAt_idx" ON "AdEvent"("campaignId", "createdAt");
