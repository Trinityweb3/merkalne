import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { campaignStats } from '@/lib/ads/auction'
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, topUpMode } from '@/lib/ads/topup'
import { allowedCoins } from '@/lib/ads/blockbee'
import { minBudgetCents } from '@/lib/ads/wallet'
import { parseTargetingCsv, toTargetingCsv } from '@/lib/ads/targeting'

export const dynamic = 'force-dynamic'

const MAX_ACTIVE_CAMPAIGNS = 12

const createSchema = z.object({
  title: z.string().trim().min(3).max(80),
  body: z.string().trim().min(3).max(200),
  ctaUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//, 'The destination URL must use https'),
  ctaLabel: z.string().trim().max(32).optional().or(z.literal('')),
  bidPerView: z.coerce.number().int().min(1).max(50), // 1¢–50¢ per view
  /** Initial flight budget drawn from the ad wallet (US cents). */
  budgetCents: z.coerce.number().int().min(1).max(50_000_00),
  /** Targeting — empty array = no restriction (show everywhere). */
  targetSections: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(6).default([]),
  targetLocales: z.array(z.string().trim().toLowerCase().min(2).max(8)).max(20).default([]),
})

/**
 * GET /api/ads/campaigns — the signed-in advertiser's campaigns with live
 * view/click counts and parsed targeting lists (used by the dashboard's
 * refresh after mutations). Also returns the active top-up configuration
 * (mode + offered coins + limits).
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const campaigns = await db.adCampaign.findMany({
      where: { advertiserId: session.user.id },
      orderBy: { createdAt: 'desc' },
    })
    const stats = await campaignStats(campaigns.map((c) => c.id))

    return jsonOk({
      campaigns: campaigns.map((c) => ({
        id: c.id,
        title: c.title,
        body: c.body,
        ctaUrl: c.ctaUrl,
        ctaLabel: c.ctaLabel,
        balance: c.balance,
        bidPerView: c.bidPerView,
        status: c.status,
        createdAt: c.createdAt.toISOString(),
        impressions: stats.get(c.id)?.impressions ?? 0,
        clicks: stats.get(c.id)?.clicks ?? 0,
        targetSections: parseTargetingCsv(c.targetSections),
        targetLocales: parseTargetingCsv(c.targetLocales),
      })),
      topUp: {
        mode: topUpMode(),
        coins: allowedCoins(),
        minCents: TOPUP_MIN_CENTS,
        maxCents: TOPUP_MAX_CENTS,
      },
    })
  } catch (err) {
    return handleRouteError(err)
  }
}

/**
 * POST /api/ads/campaigns — create a campaign FUNDED FROM THE AD WALLET.
 *
 * The wallet-first flow: the advertiser deposits crypto in the Wallet tab
 * (BlockBee → User.adBalance), then creates a campaign here choosing the
 * bid, targeting and an initial budget. The route validates that
 *
 *   • the budget covers the minimum flight (≥ $1 and ≥ 50 views at the bid)
 *   • the wallet actually holds the budget
 *
 * and transfers wallet → campaign balance inside one transaction whose
 * first statement is a conditional decrement (never overdraws the wallet).
 * The campaign starts ACTIVE — it is funded, so it serves immediately.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const rl = rateLimit(`ads-campaign-create:${session.user.id}`, 6, 60_000)
    if (!rl.ok) return jsonError('Too many campaigns created — try again in a minute.', 429)

    const parsed = createSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError('Invalid campaign', 400, { issues: parsed.error.issues })
    }
    const { title, body, ctaUrl, ctaLabel, bidPerView, budgetCents } = parsed.data
    const targetSections = toTargetingCsv(parsed.data.targetSections)
    const targetLocales = toTargetingCsv(parsed.data.targetLocales)

    const minBudget = minBudgetCents(bidPerView)
    if (budgetCents < minBudget) {
      return jsonError(
        `The initial budget must be at least $${(minBudget / 100).toFixed(2)} (≥ 50 views at your bid).`,
        400,
        { code: 'budget_too_small' },
      )
    }

    const activeCount = await db.adCampaign.count({
      where: { advertiserId: session.user.id, status: { in: ['active', 'paused'] } },
    })
    if (activeCount >= MAX_ACTIVE_CAMPAIGNS) {
      return jsonError(
        `Campaign limit reached (${MAX_ACTIVE_CAMPAIGNS}) — pause or let an old one end first.`,
        400,
      )
    }

    const campaign = await db.$transaction(async (tx) => {
      // Conditional wallet decrement — the overdraw guard. Count 0 means
      // the wallet cannot cover the budget: nothing is created.
      const debited = await tx.user.updateMany({
        where: { id: session.user.id, adBalance: { gte: budgetCents } },
        data: { adBalance: { decrement: budgetCents } },
      })
      if (debited.count !== 1) return null

      return await tx.adCampaign.create({
        data: {
          advertiserId: session.user.id,
          title,
          body,
          ctaUrl,
          ctaLabel: ctaLabel ? ctaLabel : null,
          bidPerView,
          balance: budgetCents,
          targetSections,
          targetLocales,
          // Funded at creation → live immediately. (The old "start paused
          // until top-up" dance is gone: funding happens in the Wallet tab
          // BEFORE the campaign exists.)
          status: 'active',
        },
      })
    })

    if (!campaign) {
      return jsonError(
        'Not enough money in your ad wallet — top it up in the Wallet tab first.',
        400,
        { code: 'insufficient_wallet' },
      )
    }
    return jsonOk({ id: campaign.id, status: campaign.status }, { status: 201 })
  } catch (err) {
    return handleRouteError(err)
  }
}
