/** Seeds a QA user + wallet + campaign + session for the browser smoke test. */
import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'

const db = new PrismaClient()
const TOKEN = 'qa-session-token-0123456789abcdefghijklmnop'

/** $20.00 wallet, $10.00 committed to a $0.50-per-click text campaign. */
const WALLET_CREDIT_MICRO = 20_000_000
const CAMPAIGN_BUDGET_MICRO = 10_000_000
const CPC_BID_MICRO = 500_000 // $0.50 per click

async function main() {
  const email = 'qa-ads@merklane.local'
  await db.user.deleteMany({ where: { email } })
  const user = await db.user.create({
    data: {
      email,
      name: 'QA Advertiser',
      referralCode: 'QACODE7',
      referralBalance: 3250,
    },
  })

  const wallet = await db.wallet.create({
    data: { userId: user.id, availableMicroUsd: WALLET_CREDIT_MICRO - CAMPAIGN_BUDGET_MICRO, reservedMicroUsd: CAMPAIGN_BUDGET_MICRO },
  })
  await db.ledgerEntry.createMany({
    data: [
      { walletId: wallet.id, type: 'credit', amountMicroUsd: WALLET_CREDIT_MICRO, campaignId: null, eventId: `seed:wallet:${user.id}` },
      { walletId: wallet.id, type: 'reserve', amountMicroUsd: -CAMPAIGN_BUDGET_MICRO, campaignId: 'seed-campaign', eventId: `seed:campaign:${user.id}` },
    ],
  })
  await db.campaign.create({
    data: {
      id: 'seed-campaign',
      advertiserId: user.id,
      name: 'Acme hiring — QA seed',
      format: 'text',
      billingModel: 'cpc',
      bidMicroUsd: CPC_BID_MICRO,
      dailyBudgetMicroUsd: 0,
      totalBudgetMicroUsd: CAMPAIGN_BUDGET_MICRO,
      status: 'active',
      creatives: {
        create: {
          title: 'Hire Web3 engineers on Acme',
          body: 'Reach 40k+ monthly Web3 job seekers.',
          targetUrl: 'https://acme.example/hiring',
          version: 1,
          moderationStatus: 'approved',
        },
      },
    },
  })

  // ---- Phase 4 QA data --------------------------------------------------
  // A second approved creative (v2) + a RUNNING A/B experiment with a
  // realistic history: 120 impressions per arm, 14 vs 3 clicks → a clear
  // z-test WINNER for variant A (p ≈ 0.006), spent/eCPC at the $0.50 bid.
  const v2 = await db.creative.create({
    data: {
      campaignId: 'seed-campaign',
      title: 'Acme: 300+ open Web3 roles',
      body: 'Senior Solidity, Rust and audit roles — apply today.',
      targetUrl: 'https://acme.example/hiring',
      version: 2,
      moderationStatus: 'approved',
    },
  })
  const v1 = await db.creative.findFirst({
    where: { campaignId: 'seed-campaign', version: 1 },
    select: { id: true },
  })
  if (!v1) throw new Error('seed creative v1 missing')
  const experiment = await db.experiment.create({
    data: {
      campaignId: 'seed-campaign',
      creativeAId: v1.id,
      creativeBId: v2.id,
      status: 'running',
      primaryMetric: 'ctr',
      startedAt: new Date(Date.now() - 3 * 86_400_000),
    },
  })
  // 12 assigned visitors per arm.
  await db.variantAssignment.createMany({
    data: Array.from({ length: 24 }, (_, i) => ({
      experimentId: experiment.id,
      visitorId: `qa-visitor-${i}`,
      variantId: i < 12 ? 'A' : 'B',
    })),
  })
  // Impressions + clicks per arm (reservations finalized where clicked).
  const now = Date.now()
  let seq = 0
  const rows: Array<{ variant: 'A' | 'B'; clicked: boolean }> = []
  for (let i = 0; i < 120; i++) rows.push({ variant: 'A', clicked: i < 14 })
  for (let i = 0; i < 120; i++) rows.push({ variant: 'B', clicked: i < 3 })
  for (const r of rows) {
    const rid = `qa-ab-r-${seq}`
    const at = new Date(now - Math.floor(Math.random() * 3 * 86_400_000))
    await db.budgetReservation.create({
      data: {
        id: rid,
        campaignId: 'seed-campaign',
        amountMicroUsd: CPC_BID_MICRO,
        status: r.clicked ? 'finalized' : 'expired',
        expiresAt: new Date(now - 60_000),
        variantId: r.variant,
      },
    })
    await db.adEvent.create({
      data: {
        campaignId: 'seed-campaign',
        reservationId: rid,
        eventType: 'loaded_impression',
        slot: 'feed',
        section: 'intern-junior',
        locale: 'en',
        createdAt: at,
      },
    })
    if (r.clicked) {
      await db.adEvent.create({
        data: {
          campaignId: 'seed-campaign',
          reservationId: rid,
          eventType: 'valid_click',
          slot: 'feed',
          createdAt: at,
        },
      })
    }
    seq++
  }

  // Forecast donor history: 7 days × 210 impressions (intern-junior/en) so
  // the wizard Step 4 shows a real range instead of the fallback line.
  const donor = await db.campaign.create({
    data: {
      advertiserId: user.id,
      name: 'Forecast donor (QA seed)',
      format: 'text',
      billingModel: 'cpm',
      bidMicroUsd: 200,
      totalBudgetMicroUsd: 0,
      status: 'completed',
      deletedAt: new Date(),
    },
  })
  const donorRes: Array<{ id: string; day: Date }> = []
  for (let d = 6; d >= 0; d--) {
    for (let n = 0; n < 210; n++) {
      donorRes.push({
        id: `qa-donor-r-${d}-${n}`,
        day: new Date(now - d * 86_400_000 - n * 60_000),
      })
    }
  }
  await db.budgetReservation.createMany({
    data: donorRes.map((r) => ({
      id: r.id,
      campaignId: donor.id,
      amountMicroUsd: 0,
      status: 'expired',
      expiresAt: new Date(now - 1000),
    })),
  })
  await db.adEvent.createMany({
    data: donorRes.map((r) => ({
      campaignId: donor.id,
      reservationId: r.id,
      eventType: 'loaded_impression',
      section: 'intern-junior',
      locale: 'en',
      createdAt: r.day,
    })),
  })
  await db.session.create({
    data: {
      tokenHash: createHash('sha256').update(TOKEN).digest('hex'),
      userId: user.id,
      expiresAt: new Date(Date.now() + 8 * 3600_000),
    },
  })
  console.log(`TOKEN=${TOKEN}`)
  console.log(`USER=${user.id}`)
}

main().finally(() => db.$disconnect())
