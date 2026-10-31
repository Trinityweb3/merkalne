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
import { submitCampaignForReview } from '@/lib/ads/moderation'
import { canManageCampaigns } from '@/lib/ads/permissions'
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
import {
  MAX_COUNTRIES,
  MAX_HASHTAGS,
  MAX_KEYWORDS,
  parseCountryInput,
  parseHashtagInput,
  parseKeywordInput,
  parseTargetingCsv,
  toTargetingCsv,
} from '@/lib/ads/targeting'

export const dynamic = 'force-dynamic'

const MAX_ACTIVE_CAMPAIGNS = 12
/** Drafts are free (no money locked) but capped so they cannot pile up. */
const MAX_DRAFT_CAMPAIGNS = 25

/**
 * Banner creatives must be a LOCAL upload path produced by
 * /api/ads/assets/upload — external image URLs are not accepted anymore
 * (Phase 2: real uploads only, content-validated by magic bytes).
 */
const LOCAL_BANNER_PATH = /^\/uploads\/ads\/[a-f0-9-]{8,}\.(png|jpe?g|webp)$/

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
  /**
   * Phase 2 lifecycle: false (default) creates a DRAFT — free, editable,
   * no wallet money locked. true submits it for review right away: the
   * budget is reserved from the wallet and the campaign goes to PENDING.
   */
  submit: z.boolean().default(false),
  /** https destination every click opens. */
  targetUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//, 'The destination URL must use https'),
  /** Text format: card headline + body (Phase 2 limits: 120 / 500). */
  headline: z.string().trim().min(3).max(120).optional(),
  body: z.string().trim().min(3).max(500).optional(),
  /** Text format: optional friendly domain rendered on the card. */
  displayDomain: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'The display domain must look like a host, no scheme')
    .optional()
    .or(z.literal('')),
  /** Banner format: LOCAL upload path (/uploads/ads/<uuid>.png|jpg|webp). */
  imageUrl: z.string().trim().regex(LOCAL_BANNER_PATH, 'The banner must be uploaded (PNG, JPEG or WebP)').optional(),
  /** Banner format: accessibility label. */
  altText: z.string().trim().min(2).max(120).optional(),
  /** Targeting — empty arrays = no restriction (show everywhere). */
  targetSections: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(6).default([]),
  targetLocales: z.array(z.string().trim().toLowerCase().min(2).max(8)).max(20).default([]),
  targetKeywords: z.array(z.string().trim().min(2).max(60)).max(MAX_KEYWORDS).default([]),
  keywordMatch: z.enum(['phrase', 'exact']).default('phrase'),
  targetCountries: z.array(z.string().trim().min(2).max(2)).max(MAX_COUNTRIES).default([]),
  countryMode: z.enum(['all', 'include', 'exclude']).default('all'),
  targetHashtags: z.array(z.string().trim().min(2).max(40)).max(MAX_HASHTAGS).default([]),
})

/**
 * GET /api/ads/campaigns — the signed-in advertiser's campaigns with
 * ledger-derived budget state, per-model delivery stats and the active
 * top-up configuration (mode + offered coins + limits).
 *
 * Phase 2: the payload now carries the LATEST creative of every campaign
 * regardless of its moderation status (so drafts and rejections can be
 * re-opened in the wizard), each with moderationStatus + moderationNote,
 * plus the advanced targeting selections.
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
          // Latest revision, whatever its moderation status — the wizard
          // needs to re-open drafts and rejections too.
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
          targetKeywords: parseTargetingCsv(c.targetKeywords),
          keywordMatch: c.keywordMatch,
          countryMode: c.countryMode,
          targetCountries: c.targetCountries ? parseTargetingCsv(c.targetCountries).map((x) => x.toUpperCase()) : [],
          targetHashtags: parseTargetingCsv(c.targetHashtags),
          creative: creative
            ? {
                title: creative.title,
                body: creative.body,
                imageUrl: creative.imageUrl,
                altText: creative.altText,
                displayDomain: creative.displayDomain,
                targetUrl: creative.targetUrl,
                version: creative.version,
                moderationStatus: creative.moderationStatus,
                moderationNote: creative.moderationNote,
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
 * POST /api/ads/campaigns — create a campaign from the wizard.
 *
 * Phase 2 lifecycle (no campaign ever jumps to ACTIVE from the API):
 *   • submit=false (default) → DRAFT. Free: no wallet money is locked, the
 *     planned budget is stored on the row and reserved only when the
 *     campaign is submitted for review. Drafts stay editable.
 *   • submit=true → the draft is created AND submitted in one atomic
 *     transaction: the budget moves wallet → campaign (Phase 1 ledger
 *     service), the campaign enters PENDING and waits for a moderator.
 *
 * Validation (server-side, mirrors of src/lib/ads/money.ts):
 *   • the creative fields must match the chosen format (banners must
 *     reference a LOCAL upload; external image URLs are no longer accepted)
 *   • the bid must be inside the per-model bounds
 *   • the budget must cover the minimum flight (≥ $1 AND ≥ 20 billable events)
 *   • the daily cap (when set) must be ≥ $1 and ≤ the total budget
 *   • on submit, the wallet must actually hold the budget
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    // Phase-4 permission gate: campaign creation is OWNER + EDITOR (every
    // account defaults to owner, so this only bites deliberately demoted
    // roles — see src/lib/ads/permissions.ts).
    if (!canManageCampaigns(session.user)) {
      return jsonError('Your role does not allow creating campaigns.', 403, {
        code: 'forbidden_role',
      })
    }

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
      return jsonError('Banner campaigns need an uploaded image.', 400, { code: 'creative_missing' })
    }
    if (format === 'banner' && !d.altText) {
      return jsonError('Banner campaigns need alt text (accessibility label).', 400, { code: 'creative_missing' })
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

    // ---- per-state quotas ------------------------------------------------------
    const [activeCount, draftCount] = await Promise.all([
      db.campaign.count({
        where: { advertiserId: session.user.id, deletedAt: null, status: { in: ['active', 'paused', 'pending'] } },
      }),
      db.campaign.count({
        where: { advertiserId: session.user.id, deletedAt: null, status: { in: ['draft', 'rejected'] } },
      }),
    ])
    if (activeCount >= MAX_ACTIVE_CAMPAIGNS) {
      return jsonError(
        `Campaign limit reached (${MAX_ACTIVE_CAMPAIGNS}) — delete or pause an old one first.`,
        400,
      )
    }
    if (draftCount >= MAX_DRAFT_CAMPAIGNS) {
      return jsonError(
        `You already have ${MAX_DRAFT_CAMPAIGNS} draft/rejected campaigns — submit or delete some first.`,
        400,
        { code: 'draft_limit' },
      )
    }

    const targetSections = toTargetingCsv(d.targetSections)
    const targetLocales = toTargetingCsv(d.targetLocales)
    const targetKeywords = parseKeywordInput(d.targetKeywords).join(',')
    const keywordMatch = d.keywordMatch
    const countryMode = d.countryMode
    const targetCountries = countryMode === 'all' ? '' : parseCountryInput(d.targetCountries).join(',')
    const targetHashtags = parseHashtagInput(d.targetHashtags).join(',')
    if (countryMode !== 'all' && targetCountries === '') {
      return jsonError('Pick at least one country for include/exclude targeting.', 400, {
        code: 'targeting_invalid',
      })
    }

    const budgetMicroUsd = centsToMicro(d.budgetCents)
    const bidMicroUsd = centsToMicro(d.bidCents)
    const dailyBudgetMicroUsd = centsToMicro(d.dailyBudgetCents)
    // Pre-generated id — the ledger eventId references it, and the row is
    // created inside the same transaction as the reservation.
    const campaignId = crypto.randomUUID()

    const campaign = await db.$transaction(async (tx) => {
      if (!d.submit) {
        // Draft: nothing touches the wallet. The planned budget rides on
        // the row (totalBudgetMicroUsd) and is reserved at submit time.
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
            status: 'draft',
            targetSections,
            targetLocales,
            targetKeywords,
            keywordMatch,
            countryMode,
            targetCountries,
            targetHashtags,
            creatives: {
              create: {
                moderationStatus: 'draft',
                version: 1,
                title: format === 'text' ? d.headline! : null,
                body: format === 'text' ? d.body! : null,
                imageUrl: format === 'banner' ? d.imageUrl! : null,
                altText: format === 'banner' ? d.altText! : null,
                displayDomain: d.displayDomain ? d.displayDomain : null,
                targetUrl: d.targetUrl,
              },
            },
          },
          include: { creatives: true },
        })
      }

      // Create + submit in ONE transaction: reserve the budget from the
      // wallet (conditional decrement — never overdraws), then flip the
      // fresh draft straight into review.
      const reserved = await reserveCampaignBudget(tx, {
        userId: session.user.id,
        campaignId,
        amountMicroUsd: budgetMicroUsd,
        eventId: `campaign:${campaignId}:create`,
      })
      if (!reserved.ok) return null

      const created = await tx.campaign.create({
        data: {
          id: campaignId,
          advertiserId: session.user.id,
          name: d.name,
          format,
          billingModel,
          bidMicroUsd,
          dailyBudgetMicroUsd,
          totalBudgetMicroUsd: budgetMicroUsd,
          status: 'pending',
          targetSections,
          targetLocales,
          targetKeywords,
          keywordMatch,
          countryMode,
          targetCountries,
          targetHashtags,
          creatives: {
            create: {
              moderationStatus: 'pending',
              version: 1,
              title: format === 'text' ? d.headline! : null,
              body: format === 'text' ? d.body! : null,
              imageUrl: format === 'banner' ? d.imageUrl! : null,
              altText: format === 'banner' ? d.altText! : null,
              displayDomain: d.displayDomain ? d.displayDomain : null,
              targetUrl: d.targetUrl,
            },
          },
        },
        include: { creatives: true },
      })

      // Created straight into PENDING with the budget already reserved —
      // the same end state submitCampaignForReview produces, reached in
      // one transaction (the campaign never existed as a visible draft).
      return created
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
