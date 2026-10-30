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
