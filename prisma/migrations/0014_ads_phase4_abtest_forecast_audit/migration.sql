-- Merklane Ads Phase 4 — A/B testing, delivery forecasting, admin roles
-- and the audit log.
--
--   Experiment (NEW TABLE): one A/B test per campaign. Exactly two APPROVED
--     creatives (creativeAId/creativeBId) of the same campaign; the campaign
--     keeps a SINGLE weight in the auction — the variant is chosen only after
--     the campaign WINS the draw (src/lib/ads/auction.ts), so an A/B campaign
--     never doubles its win probability. status: draft | running | finished.
--
--   VariantAssignment (NEW TABLE): the per-visitor split ledger. One row per
--     (experiment, visitor) — UNIQUE(experimentId, visitorId). The variant
--     itself is a STABLE HASH sha256(experimentId | visitorId) mod 2, so the
--     same visitor always lands in the same arm; the row is the durable proof.
--
--   AuditLog (NEW TABLE): who did what, when and why — APPROVE_CAMPAIGN,
--     REJECT_CAMPAIGN, ADJUST_BALANCE, GRANT_PREMIUM, REVOKE_PREMIUM,
--     SET_ROLE. actorId is the acting platform User id when resolvable,
--     otherwise the bot actor label "tg-admin:<id>" (deliberately not a FK).
--
--   User.adminRole (NEW COLUMN, default "owner"): granular permission tier —
--     owner | editor | analyst | billing. The default makes every EXISTING
--     account an owner, so the Phase-4 permission gates change nobody's
--     behaviour until a role is deliberately demoted (constraint: do not
--     break the existing flows). Enforced in src/lib/ads/permissions.ts.
--
--   BudgetReservation.variantId (NEW NULLABLE COLUMN): "A" | "B" on serves
--     delivered through a RUNNING experiment — the per-variant attribution
--     stamp. Null on every legacy row and every ordinary serve; the
--     experiment statistics join AdEvent → BudgetReservation.variantId.
--
--   AdEvent.section / AdEvent.locale (NEW NULLABLE COLUMNS): the serving
--     page context stored on loaded_impression rows — the input of the
--     Phase-4 delivery forecast (/api/ads/forecast), filtered by the
--     campaign's targeting (locale, section).
--
-- Every statement is valid on BOTH PostgreSQL (prisma migrate deploy) and
-- SQLite (scripts/apply-migration-sql.ts) — see prisma/schema.prisma header.
-- Pure additive DDL: no existing column is altered, no data is transformed,
-- existing rows keep serving through the Phase 1–3 paths unchanged.

-- CreateTable: Experiment
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creativeAId" TEXT NOT NULL,
    "creativeBId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "primaryMetric" TEXT NOT NULL DEFAULT 'ctr',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Experiment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: the "one live experiment per campaign" lookup (serve path)
CREATE INDEX "Experiment_campaignId_status_idx" ON "Experiment"("campaignId", "status");

-- CreateTable: VariantAssignment
-- (foreign key inline, the 0011/0013 convention — valid on both engines)
CREATE TABLE "VariantAssignment" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VariantAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VariantAssignment_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: one arm per visitor per experiment (the dedupe / proof guard)
CREATE UNIQUE INDEX "VariantAssignment_experimentId_visitorId_key" ON "VariantAssignment"("experimentId", "visitorId");

-- CreateIndex: arm sizes at a glance
CREATE INDEX "VariantAssignment_experimentId_variantId_idx" ON "VariantAssignment"("experimentId", "variantId");

-- CreateTable: AuditLog
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: newest-first audit view
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex: per-action filtering (e.g. every REJECT_CAMPAIGN ever)
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex: the target's history (one campaign / one user / one top-up)
CREATE INDEX "AuditLog_targetId_idx" ON "AuditLog"("targetId");

-- AlterTable: User — granular ads-workspace permission tier.
-- DEFAULT 'owner' backfills every existing account with FULL rights, so the
-- Phase-4 gates are invisible until a role is deliberately demoted.
ALTER TABLE "User" ADD COLUMN "adminRole" TEXT NOT NULL DEFAULT 'owner';

-- AlterTable: BudgetReservation — the A/B attribution stamp (nullable).
ALTER TABLE "BudgetReservation" ADD COLUMN "variantId" TEXT;

-- AlterTable: AdEvent — the serving-page context for forecasting (nullable).
ALTER TABLE "AdEvent" ADD COLUMN "section" TEXT;
ALTER TABLE "AdEvent" ADD COLUMN "locale" TEXT;

-- CreateIndex: the forecast aggregation path (loaded_impression by page
-- context over time). Plain (non-unique) index — AdEvent rows are append-only.
CREATE INDEX "AdEvent_eventType_section_locale_createdAt_idx" ON "AdEvent"("eventType", "section", "locale", "createdAt");
