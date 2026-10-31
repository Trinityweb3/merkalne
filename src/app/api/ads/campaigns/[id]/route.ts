import { z } from 'zod'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { campaignBudgetStates, expireStaleReservations } from '@/lib/ads/auction'
import { refundCampaignBudget, reserveCampaignBudget, MIN_ALLOCATION_CENTS } from '@/lib/ads/wallet'
import { submitCampaignForReview } from '@/lib/ads/moderation'
import {
  MAX_COUNTRIES,
  MAX_HASHTAGS,
  MAX_KEYWORDS,
  parseCountryInput,
  parseHashtagInput,
  parseKeywordInput,
  toTargetingCsv,
} from '@/lib/ads/targeting'
import {
  BID_BOUNDS,
  DAILY_BUDGET_BOUNDS,
  TOTAL_BUDGET_BOUNDS,
  centsToMicro,
  formatMicroUsd,
  minTotalBudgetCents,
  perEventMicroUsd,
  type BillingModel,
} from '@/lib/ads/money'

export const dynamic = 'force-dynamic'

/** Banner creatives must reference a local upload (Phase 2: no external URLs). */
const LOCAL_BANNER_PATH = /^\/uploads\/ads\/[a-f0-9-]{8,}\.(png|jpe?g|webp)$/

/** Editable in every state that allows 'update' (completed/deleted do not). */
const EDITABLE_STATES = ['draft', 'pending', 'rejected', 'active', 'paused'] as const

const patchSchema = z.object({
  action: z.enum(['pause', 'resume', 'fund', 'update', 'delete', 'submit']),
  /** action === 'fund': amount moved from the wallet into the campaign. */
  amountCents: z.coerce.number().int().min(1).max(5_000_000).optional(),
  /**
   * action === 'update' — all fields optional; the billing model, format
   * and id are immutable by design (a campaign has exactly ONE model).
   * budgetCents is only honoured for DRAFT campaigns (the planned budget);
   * funded campaigns change their budget through 'fund'.
   * submitForReview: apply the edit AND submit for review in one call
   * (wizard Step 5 / resubmitting a rejected campaign).
   */
  name: z.string().trim().min(3).max(80).optional(),
  bidCents: z.coerce.number().int().min(1).max(5_000).optional(),
  dailyBudgetCents: z.coerce.number().int().min(0).max(DAILY_BUDGET_BOUNDS.maxCents).optional(),
  budgetCents: z.coerce.number().int().min(1).optional(),
  submitForReview: z.boolean().optional(),
  targetUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//, 'The destination URL must use https')
    .optional(),
  headline: z.string().trim().min(3).max(120).optional(),
  body: z.string().trim().min(3).max(500).optional(),
  imageUrl: z.string().trim().regex(LOCAL_BANNER_PATH, 'The banner must be uploaded (PNG, JPEG or WebP)').optional(),
  altText: z.string().trim().min(2).max(120).optional(),
  displayDomain: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'The display domain must look like a host, no scheme')
    .optional()
    .or(z.literal('')),
  targetSections: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(6).optional(),
  targetLocales: z.array(z.string().trim().toLowerCase().min(2).max(8)).max(20).optional(),
  targetKeywords: z.array(z.string().trim().min(2).max(60)).max(MAX_KEYWORDS).optional(),
  keywordMatch: z.enum(['phrase', 'exact']).optional(),
  targetCountries: z.array(z.string().trim().min(2).max(2)).max(MAX_COUNTRIES).optional(),
  countryMode: z.enum(['all', 'include', 'exclude']).optional(),
  targetHashtags: z.array(z.string().trim().min(2).max(40)).max(MAX_HASHTAGS).optional(),
})

/** Split a stored CSV column back into a list (never throws). */
function parseCsvList(csv: string): string[] {
  return (csv ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * PATCH /api/ads/campaigns/[id] — manage one of the advertiser's own
 * campaigns:
 *
 *   submit  DRAFT/REJECTED → PENDING (Phase 2): reserves the planned budget
 *          from the wallet the first time, flips the latest creative to
 *          "pending". No campaign ever becomes ACTIVE here — that is the
 *          moderator's decision (Telegram admin bot).
 *   pause   stop serving (status → paused)
 *   resume  serve again — only while the derived budget still covers one
 *           billable event
 *   fund    move more wallet money into this campaign's budget (adds a
 *           RESERVE ledger row; blocked for drafts — submit first)
 *   update  edit name/bid/daily cap/targeting/content. Content edits append
 *           a NEW creative version (append-only history, v+1). Editing an
 *           APPROVED (active/paused) campaign creates that new revision and
 *           sends the campaign back to PENDING (Phase 2 rule); drafts stay
 *           drafts, rejected campaigns stay rejected until resubmitted.
 *           With submitForReview=true the edit is applied AND the campaign
 *           is submitted for review atomically.
 *   delete  soft delete (works from EVERY state): expires every in-flight
 *           hold, REFUNDS the unspent budget to the wallet (REFUND ledger
 *           row) and sets deletedAt — the campaign never serves again
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const { id } = await ctx.params
    const parsed = patchSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return jsonError('Invalid action', 400, { issues: parsed.error.issues })

    const rl = rateLimit(`ads-campaign-patch:${session.user.id}`, 20, 60_000)
    if (!rl.ok) return jsonError('Too many updates — try again in a minute.', 429)

    const campaign = await db.campaign.findUnique({
      where: { id },
      include: {
        // Latest revision whatever its status — updates build v+1 from it.
        creatives: { orderBy: { version: 'desc' }, take: 1 },
      },
    })
    if (!campaign || campaign.advertiserId !== session.user.id) {
      return jsonError('Campaign not found', 404)
    }
    if (campaign.deletedAt) {
      return jsonError('This campaign was deleted.', 400, { code: 'already_deleted' })
    }

    const { action } = parsed.data
    const model = campaign.billingModel as BillingModel
    const perEvent = perEventMicroUsd(model, campaign.bidMicroUsd)

    // ------------------------------------------------------------------ submit
    if (action === 'submit') {
      const result = await db.$transaction(async (tx) =>
        submitCampaignForReview(tx, { campaignId: campaign.id, userId: session.user.id }),
      )
      if (!result.ok) {
        const status =
          result.code === 'insufficient_wallet' ? 400 : result.code === 'not_found' ? 404 : 409
        return jsonError(result.message, status, { code: result.code })
      }
      return jsonOk({ status: 'pending', submittedAt: new Date().toISOString() })
    }

    // ------------------------------------------------------------------ fund
    if (action === 'fund') {
      const amountCents = parsed.data.amountCents
      if (amountCents === undefined) return jsonError('amountCents is required', 400)
      if (amountCents < MIN_ALLOCATION_CENTS) {
        return jsonError('The minimum allocation is $1.00.', 400, { code: 'amount_too_small' })
      }
      if (campaign.status === 'completed') {
        return jsonError('Completed campaigns cannot be funded — create a new campaign instead.', 400)
      }
      if (campaign.status === 'draft') {
        return jsonError(
          'Drafts do not hold budget yet — submit the campaign for review first, then add funds.',
          400,
          { code: 'draft_not_fundable' },
        )
      }
      const amountMicroUsd = centsToMicro(amountCents)
      const result = await db.$transaction(async (tx) => {
        const reserved = await reserveCampaignBudget(tx, {
          userId: session.user.id,
          campaignId: campaign.id,
          amountMicroUsd,
          // Fresh id per call — every "add funds" click is a distinct intent;
          // the conditional wallet decrement is the overdraw guard.
          eventId: `fund:${campaign.id}:${crypto.randomUUID()}`,
        })
        if (!reserved.ok) return null
        return await tx.campaign.update({
          where: { id: campaign.id },
          data: { totalBudgetMicroUsd: { increment: amountMicroUsd } },
        })
      })
      if (!result) {
        return jsonError(
          'Not enough money in your ad wallet — top it up in the Wallet tab first.',
          400,
          { code: 'insufficient_wallet' },
        )
      }
      return jsonOk({
        status: campaign.status,
        totalBudgetMicroUsd: result.totalBudgetMicroUsd,
        availableMicroUsd: (await db.wallet.findUnique({ where: { userId: session.user.id } }))?.availableMicroUsd ?? 0,
      })
    }

    // ------------------------------------------------------------------ update
    if (action === 'update') {
      if (!(EDITABLE_STATES as readonly string[]).includes(campaign.status)) {
        return jsonError('Completed campaigns cannot be edited — create a new campaign instead.', 400)
      }
      const d = parsed.data

      if (d.bidCents !== undefined) {
        const bounds = BID_BOUNDS[model]
        if (d.bidCents < bounds.minCents || d.bidCents > bounds.maxCents) {
          return jsonError(
            model === 'cpc'
              ? `The bid must be between $${(bounds.minCents / 100).toFixed(2)} and $${(bounds.maxCents / 100).toFixed(2)} per click.`
              : `The bid must be between $${(bounds.minCents / 100).toFixed(2)} and $${(bounds.maxCents / 100).toFixed(2)} per 1000 views.`,
            400,
            { code: 'bid_out_of_range' },
          )
        }
      }
      if (d.dailyBudgetCents !== undefined && d.dailyBudgetCents !== 0) {
        if (d.dailyBudgetCents < DAILY_BUDGET_BOUNDS.minCents) {
          return jsonError('The daily budget must be $1.00 or more (0 = no daily cap).', 400, {
            code: 'daily_budget_invalid',
          })
        }
        if (centsToMicro(d.dailyBudgetCents) > campaign.totalBudgetMicroUsd) {
          return jsonError('The daily budget cannot exceed the total budget.', 400, {
            code: 'daily_budget_invalid',
          })
        }
      }

      // Planned budget — drafts only (funded campaigns use 'fund').
      let plannedBudgetMicroUsd = campaign.totalBudgetMicroUsd
      if (d.budgetCents !== undefined) {
        if (campaign.status !== 'draft') {
          return jsonError(
            'The budget of a submitted campaign changes through "Add funds" — not here.',
            400,
            { code: 'budget_immutable' },
          )
        }
        // The effective bid after this edit (current bid when unchanged).
        const effectiveBidCents = d.bidCents ?? campaign.bidMicroUsd / 10_000
        const minBudgetCents = minTotalBudgetCents(model, effectiveBidCents)
        if (d.budgetCents < minBudgetCents || d.budgetCents > TOTAL_BUDGET_BOUNDS.maxCents) {
          return jsonError(
            `The total budget must be at least ${formatMicroUsd(centsToMicro(minBudgetCents))} — at least 20 billable events at your bid.`,
            400,
            { code: 'budget_too_small' },
          )
        }
        plannedBudgetMicroUsd = centsToMicro(d.budgetCents)
      }

      // Country targeting consistency: include/exclude needs ≥ 1 country.
      const nextCountryMode = d.countryMode ?? campaign.countryMode
      const nextCountries = parseCountryInput(
        d.targetCountries ?? parseCsvList(campaign.targetCountries),
      )
      if (nextCountryMode !== 'all' && nextCountries.length === 0) {
        return jsonError('Pick at least one country for include/exclude targeting.', 400, {
          code: 'targeting_invalid',
        })
      }

      // Format-specific creative edits (partial — unspecified fields keep
      // their current value from the latest creative version).
      const current = campaign.creatives[0] ?? null
      const nextTitle = d.headline !== undefined ? d.headline : (current?.title ?? null)
      const nextBody = d.body !== undefined ? d.body : (current?.body ?? null)
      const nextImage = d.imageUrl !== undefined ? d.imageUrl : (current?.imageUrl ?? null)
      const nextAlt = d.altText !== undefined ? d.altText : (current?.altText ?? null)
      if (campaign.format === 'text' && (!nextTitle || !nextBody)) {
        return jsonError('Text campaigns need a headline and body copy.', 400, { code: 'creative_missing' })
      }
      if (campaign.format === 'banner' && (!nextImage || !nextAlt)) {
        return jsonError('Banner campaigns need an uploaded image and alt text.', 400, { code: 'creative_missing' })
      }

      // Which creative status does the NEW revision get?
      //   draft campaign     → "draft" (still editable, not in review)
      //   everything else    → "pending" (in review / revision awaiting review)
      const nextCreativeStatus = campaign.status === 'draft' ? 'draft' : 'pending'

      // Campaign status after the edit:
      //   draft / rejected / pending → unchanged (rejected stays rejected
      //   until the advertiser resubmits; pending stays in review)
      //   active / paused → PENDING: editing an APPROVED campaign sends it
      //   back to review with its new revision (Phase 2 rule)
      const nextCampaignStatus =
        campaign.status === 'active' || campaign.status === 'paused' ? 'pending' : campaign.status

      const updated = await db.$transaction(async (tx) => {
        const row = await tx.campaign.update({
          where: { id: campaign.id },
          data: {
            ...(d.name !== undefined ? { name: d.name } : {}),
            ...(d.bidCents !== undefined ? { bidMicroUsd: centsToMicro(d.bidCents) } : {}),
            ...(d.dailyBudgetCents !== undefined
              ? { dailyBudgetMicroUsd: centsToMicro(d.dailyBudgetCents) }
              : {}),
            ...(d.budgetCents !== undefined ? { totalBudgetMicroUsd: plannedBudgetMicroUsd } : {}),
            ...(d.targetSections !== undefined ? { targetSections: toTargetingCsv(d.targetSections) } : {}),
            ...(d.targetLocales !== undefined ? { targetLocales: toTargetingCsv(d.targetLocales) } : {}),
            ...(d.targetKeywords !== undefined
              ? { targetKeywords: parseKeywordInput(d.targetKeywords).join(',') }
              : {}),
            ...(d.keywordMatch !== undefined ? { keywordMatch: d.keywordMatch } : {}),
            ...(d.countryMode !== undefined || d.targetCountries !== undefined
              ? { countryMode: nextCountryMode, targetCountries: nextCountries.join(',') }
              : {}),
            ...(d.targetHashtags !== undefined
              ? { targetHashtags: parseHashtagInput(d.targetHashtags).join(',') }
              : {}),
            status: nextCampaignStatus,
          },
        })

        // Content edits append creative v+1 (append-only history). On
        // approved campaigns every edit creates the revision (the spec
        // sends the campaign back to review); on drafts a content edit
        // appends too — the wizard is free to keep refining a draft.
        const contentChanged =
          d.targetUrl !== undefined ||
          d.headline !== undefined ||
          d.body !== undefined ||
          d.imageUrl !== undefined ||
          d.altText !== undefined ||
          d.displayDomain !== undefined
        const nextVersion = (current?.version ?? 0) + 1
        if (contentChanged || campaign.status === 'active' || campaign.status === 'paused') {
          await tx.creative.create({
            data: {
              campaignId: campaign.id,
              title: nextTitle,
              body: nextBody,
              imageUrl: nextImage,
              altText: nextAlt,
              displayDomain: d.displayDomain !== undefined ? (d.displayDomain || null) : (current?.displayDomain ?? null),
              targetUrl: d.targetUrl ?? (current?.targetUrl ?? ''),
              version: nextVersion,
              moderationStatus: nextCreativeStatus,
            },
          })
        }
        return { row, contentChanged, nextVersion }
      })

      // Optional: apply the edit AND submit for review atomically (wizard
      // Step 5 on a draft/rejected campaign).
      if (d.submitForReview) {
        const result = await db.$transaction(async (tx) =>
          submitCampaignForReview(tx, { campaignId: campaign.id, userId: session.user.id }),
        )
        if (!result.ok) {
          return jsonError(result.message, result.code === 'insufficient_wallet' ? 400 : 409, {
            code: result.code,
          })
        }
        return jsonOk({
          status: 'pending',
          version: updated.nextVersion,
          submitted: true,
        })
      }

      return jsonOk({
        status: updated.row.status,
        version: updated.nextVersion,
        contentChanged: updated.contentChanged,
      })
    }

    // ------------------------------------------------------------------ delete
    if (action === 'delete') {
      const result = await db.$transaction(async (tx) => {
        // 1. Release every in-flight hold — late clicks on them no-op
        //    (their status flip can never match "held" again).
        await tx.budgetReservation.updateMany({
          where: { campaignId: campaign.id, status: 'held' },
          data: { status: 'expired' },
        })
        // 2. Post-expiry budget state (held is now zero).
        const states = await campaignBudgetStates([campaign.id], new Date(), tx)
        const state = states.get(campaign.id)
        const refundable = state ? state.committedMicroUsd - state.spentMicroUsd : 0
        // 3. Refund the unspent budget (deterministic eventId — a double
        //    delete can never double-refund). Drafts have nothing
        //    committed: refundable is 0 and no refund row is written.
        if (refundable > 0) {
          const refunded = await refundCampaignBudget(tx, {
            userId: session.user.id,
            campaignId: campaign.id,
            amountMicroUsd: refundable,
          })
          if (!refunded.ok) throw new Error('refund guard refused')
        }
        // 4. Soft delete — from EVERY state (draft, pending, rejected,
        //    active, paused alike).
        return await tx.campaign.update({
          where: { id: campaign.id },
          data: { deletedAt: new Date(), status: 'completed' },
        })
      })
      return jsonOk({
        status: 'deleted',
        deletedAt: result.deletedAt?.toISOString() ?? null,
      })
    }

    // ---------------------------------------------------------- pause/resume
    if (action === 'pause') {
      if (campaign.status !== 'active') {
        return jsonError('Only active campaigns can be paused.', 400, { code: 'not_active' })
      }
      await db.campaign.update({ where: { id }, data: { status: 'paused' } })
      return jsonOk({ status: 'paused' })
    }

    // resume: only with a derived budget that still covers one billable event
    if (campaign.status !== 'paused') {
      return jsonError('Only paused campaigns can be resumed.', 400, { code: 'not_paused' })
    }
    await expireStaleReservations()
    const states = await campaignBudgetStates([campaign.id])
    const remaining = states.get(campaign.id)?.remainingMicroUsd ?? 0
    if (remaining < perEvent) {
      return jsonError(
        `Out of budget — the remaining ${formatMicroUsd(remaining)} cannot cover one more event (${formatMicroUsd(perEvent)}). Add funds before resuming.`,
        400,
        { code: 'out_of_budget' },
      )
    }
    await db.campaign.update({ where: { id }, data: { status: 'active' } })
    return jsonOk({ status: 'active', remainingMicroUsd: remaining })
  } catch (err) {
    return handleRouteError(err)
  }
}
