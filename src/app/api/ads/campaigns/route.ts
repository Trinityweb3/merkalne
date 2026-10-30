import { z } from 'zod'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { expireStaleReservations, campaignStats, campaignBudgetStates } from '@/lib/ads/auction'
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, topUpMode } from '@/lib/ads/topup'
import { allowedCoins } from '@/lib/ads/blockbee'
import { reserveCampaignBudget } from '@/lib/ads/wallet'
import {
  BID_BOUNDS,
  DAILY_BUDGET_BOUNDS,
  TOTAL_BUDGET_BOUNDS,
  centsToMicro,
  formatMicroUsd,
  minTotalBudgetCents,
  type AdFormat,
  type BillingModel,
} from '@/lib/ads/money'
import { parseTargetingCsv, toTargetingCsv } from '@/lib/ads/targeting'

export const dynamic = 'force-dynamic'

const MAX_ACTIVE_CAMPAIGNS = 12

const createSchema = z.object({
  /** Internal/administrative name shown in the dashboard. */
  name: z.string().trim().min(3).max(80),
  /** Creative shape — independent of the billing model. */
  format: z.enum(['text', 'banner']),
  /** Exactly one billing model per campaign — independent of the format. */
  billingModel: z.enum(['cpc', 'cpm']),
  /** Bid in WHOLE US cents: CPC $/click, CPM $/1000 views (bounds per model). */
  bidCents: z.coerce.number().int().min(1).max(5_000),
  /** Total flight budget drawn from the wallet (US cents). */
  budgetCents: z.coerce.number().int().min(1).max(TOTAL_BUDGET_BOUNDS.maxCents),
  /** Per-UTC-day spend cap; 0 = no daily cap. */
  dailyBudgetCents: z.coerce.number().int().min(0).max(DAILY_BUDGET_BOUNDS.maxCents).default(0),
  /** https destination every click opens. */
  targetUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//, 'The destination URL must use https'),
  /** Text format: card headline + body. */
  headline: z.string().trim().min(3).max(80).optional(),
  body: z.string().trim().min(3).max(200).optional(),
  /** Banner format: https image URL. */
  imageUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//, 'The image URL must use https')
    .optional(),
  /** Targeting — empty array = no restriction (show everywhere). */
  targetSections: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(6).default([]),
  targetLocales: z.array(z.string().trim().toLowerCase().min(2).max(8)).max(20).default([]),
})

/**
 * GET /api/ads/campaigns — the signed-in advertiser's campaigns with
 * ledger-derived budget state, per-model delivery stats and the active
 * top-up configuration (mode + offered coins + limits).
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    // Sweep first so held-but-expired holds stop counting against budgets.
    await expireStaleReservations()

    const campaigns = await db.campaign.findMany({
      where: { advertiserId: session.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        creatives: {
          where: { moderationStatus: 'approved' },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    })
    const ids = campaigns.map((c) => c.id)
    const [stats, states] = await Promise.all([campaignStats(ids), campaignBudgetStates(ids)])

    return jsonOk({
      campaigns: campaigns.map((c) => {
        const creative = c.creatives[0] ?? null
        const state = states.get(c.id)
        const stat = stats.get(c.id)
        return {
          id: c.id,
          name: c.name,
          format: c.format,
          billingModel: c.billingModel,
          bidMicroUsd: c.bidMicroUsd,
          dailyBudgetMicroUsd: c.dailyBudgetMicroUsd,
          totalBudgetMicroUsd: c.totalBudgetMicroUsd,
          status: c.status,
          deletedAt: c.deletedAt?.toISOString() ?? null,
          createdAt: c.createdAt.toISOString(),
          targetSections: parseTargetingCsv(c.targetSections),
          targetLocales: parseTargetingCsv(c.targetLocales),
          creative: creative
            ? {
                title: creative.title,
                body: creative.body,
                imageUrl: creative.imageUrl,
                targetUrl: creative.targetUrl,
                version: creative.version,
              }
            : null,
          budget: {
            committedMicroUsd: state?.committedMicroUsd ?? 0,
            spentMicroUsd: state?.spentMicroUsd ?? 0,
            heldMicroUsd: state?.heldMicroUsd ?? 0,
            remainingMicroUsd: state?.remainingMicroUsd ?? 0,
            spentTodayMicroUsd: state?.spentTodayMicroUsd ?? 0,
          },
          stats: {
            /** CPC: reservations served. CPM: finalised views. */
            served: c.billingModel === 'cpc' ? (stat?.reservations ?? 0) : (stat?.finalized ?? 0),
            views: stat?.finalized ?? 0,
            /** CPC clicks (finalised holds). CPM clicks are not billed in Phase 1. */
            clicks: c.billingModel === 'cpc' ? (stat?.finalized ?? 0) : 0,
            held: stat?.held ?? 0,
          },
        }
      }),
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
 * POST /api/ads/campaigns — create a campaign, allocating its total budget
 * from the unified Wallet.
 *
 * The wallet-first flow: the advertiser deposits crypto in the Wallet tab
 * (BlockBee → Wallet.availableMicroUsd + CREDIT ledger row), then creates a
 * campaign here choosing FORMAT (text/banner) and BILLING MODEL (cpc/cpm)
 * independently, the bid, the daily cap, the targeting and the total budget.
 *
 * Validation (server-side, mirrors of src/lib/ads/money.ts):
 *   • the creative fields must match the chosen format
 *   • the bid must be inside the per-model bounds
 *   • the budget must cover the minimum flight (≥ $1 AND ≥ 20 billable events)
 *   • the daily cap (when set) must be ≥ $1 and ≤ the total budget
 *   • the wallet must actually hold the budget
 *
 * The transfer (wallet → campaign budget) is one transaction whose first
 * statement is a conditional decrement (never overdraws the wallet). The
 * campaign starts ACTIVE — it is funded, so it serves immediately.
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
    const d = parsed.data
    const format = d.format as AdFormat
    const billingModel = d.billingModel as BillingModel

    // ---- format-specific creative validation --------------------------------
    if (format === 'text' && (!d.headline || !d.body)) {
      return jsonError('Text campaigns need a headline and body copy.', 400, { code: 'creative_missing' })
    }
    if (format === 'banner' && !d.imageUrl) {
      return jsonError('Banner campaigns need an image URL.', 400, { code: 'creative_missing' })
    }

    // ---- bid bounds per model ----------------------------------------------
    const bidBounds = BID_BOUNDS[billingModel]
    if (d.bidCents < bidBounds.minCents || d.bidCents > bidBounds.maxCents) {
      return jsonError(
        billingModel === 'cpc'
          ? `The bid must be between $${(bidBounds.minCents / 100).toFixed(2)} and $${(bidBounds.maxCents / 100).toFixed(2)} per click.`
          : `The bid must be between $${(bidBounds.minCents / 100).toFixed(2)} and $${(bidBounds.maxCents / 100).toFixed(2)} per 1000 views.`,
        400,
        { code: 'bid_out_of_range' },
      )
    }

    // ---- budget rules --------------------------------------------------------
    const minBudget = minTotalBudgetCents(billingModel, d.bidCents)
    if (d.budgetCents < minBudget) {
      return jsonError(
        `The total budget must be at least ${formatMicroUsd(centsToMicro(minBudget))} — at least 20 billable events at your bid.`,
        400,
        { code: 'budget_too_small' },
      )
    }
    if (d.dailyBudgetCents !== 0) {
      if (d.dailyBudgetCents < DAILY_BUDGET_BOUNDS.minCents) {
        return jsonError('The daily budget must be $1.00 or more (0 = no daily cap).', 400, {
          code: 'daily_budget_invalid',
        })
      }
      if (d.dailyBudgetCents > d.budgetCents) {
        return jsonError('The daily budget cannot exceed the total budget.', 400, {
          code: 'daily_budget_invalid',
        })
      }
    }

    const activeCount = await db.campaign.count({
      where: { advertiserId: session.user.id, deletedAt: null, status: { in: ['active', 'paused'] } },
    })
    if (activeCount >= MAX_ACTIVE_CAMPAIGNS) {
      return jsonError(
        `Campaign limit reached (${MAX_ACTIVE_CAMPAIGNS}) — delete or pause an old one first.`,
        400,
      )
    }

    const targetSections = toTargetingCsv(d.targetSections)
    const targetLocales = toTargetingCsv(d.targetLocales)
    const budgetMicroUsd = centsToMicro(d.budgetCents)
    const bidMicroUsd = centsToMicro(d.bidCents)
    const dailyBudgetMicroUsd = centsToMicro(d.dailyBudgetCents)
    // Pre-generated id — the ledger eventId references it, and the row is
    // created inside the same transaction as the reservation.
    const campaignId = crypto.randomUUID()

    const campaign = await db.$transaction(async (tx) => {
      // Conditional wallet decrement — the overdraw guard. count 0 means
      // the wallet cannot cover the budget: nothing is created.
      const reserved = await reserveCampaignBudget(tx, {
        userId: session.user.id,
        campaignId,
        amountMicroUsd: budgetMicroUsd,
        eventId: `campaign:${campaignId}:create`,
      })
      if (!reserved.ok) return null

      return await tx.campaign.create({
        data: {
          id: campaignId,
          advertiserId: session.user.id,
          name: d.name,
          format,
          billingModel,
          bidMicroUsd,
          dailyBudgetMicroUsd,
          totalBudgetMicroUsd: budgetMicroUsd,
          // Funded at creation → live immediately.
          status: 'active',
          targetSections,
          targetLocales,
          creatives: {
            create: {
              // Phase 1 auto-approves (no moderation queue yet).
              moderationStatus: 'approved',
              version: 1,
              title: format === 'text' ? d.headline! : null,
              body: format === 'text' ? d.body! : null,
              imageUrl: format === 'banner' ? d.imageUrl! : null,
              targetUrl: d.targetUrl,
            },
          },
        },
        include: { creatives: true },
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
