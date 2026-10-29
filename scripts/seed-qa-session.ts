/** Seeds a QA user + campaign + session for the browser smoke test. */
import { PrismaClient } from '@prisma/client'
import { createHash, randomBytes } from 'node:crypto'

const db = new PrismaClient()
const TOKEN = 'qa-session-token-0123456789abcdefghijklmnop'

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
  await db.adCampaign.create({
    data: {
      advertiserId: user.id,
      title: 'Hire Web3 engineers on Acme',
      body: 'Reach 40k+ monthly Web3 job seekers.',
      ctaUrl: 'https://acme.example/hiring',
      bidPerView: 2,
      balance: 1240,
      status: 'active',
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
