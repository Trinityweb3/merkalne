import { z } from 'zod'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { campaignBudgetStates, expireStaleReservations } from '@/lib/ads/auction'
import { refundCampaignBudget, reserveCampaignBudget, MIN_ALLOCATION_CENTS } from '@/lib/ads/wallet'
import { toTargetingCsv } from '@/lib/ads/targeting'
import {
  BID_BOUNDS,
  DAILY_BUDGET_BOUNDS,
  centsToMicro,
  formatMicroUsd,
  perEventMicroUsd,
  type BillingModel,
} from '@/lib/ads/money'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  action: z.enum(['pause', 'resume', 'fund', 'update', 'delete']),
  /** action === 'fund': amount moved from the wallet into the campaign. */
  amountCents: z.coerce.number().int().min(1).max(5_000_000).optional(),
  /** action === 'update' — all fields optional; the billing model, format
   *  and id are immutable by design (a campaign has exactly ONE model). */
  name: z.string().trim().min(3).max(80).optional(),
  bidCents: z.coerce.number().int().min(1).max(5_000).optional(),
  dailyBudgetCents: z.coerce.number().int().min(0).max(DAILY_BUDGET_BOUNDS.maxCents).optional(),
  targetUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//, 'The destination URL must use https')
    .optional(),
  headline: z.string().trim().min(3).max(80).optional(),
  body: z.string().trim().min(3).max(200).optional(),
  imageUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//, 'The image URL must use https')
    .optional(),
  targetSections: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(6).optional(),
  targetLocales: z.array(z.string().trim().toLowerCase().min(2).max(8)).max(20).optional(),
})

/**
 * PATCH /api/ads/campaigns/[id] — manage one of the advertiser's own
 * campaigns:
 *
 *   pause   stop serving (status → paused)
 *   resume  serve again — only while the derived budget still covers one
 *           billable event
 *   fund    move more wallet money into this campaign's budget (adds a
 *           RESERVE ledger row; the deposit itself lives in the Wallet tab)
 *   update  edit name/bid/daily cap/targeting/content — content edits append
 *           a NEW creative version (append-only history, v+1)
 *   delete  soft delete: expires every in-flight hold, REFUNDS the unspent
 *           budget to the wallet (REFUND ledger row) and sets deletedAt —
 *           the campaign never serves again
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
        creatives: { where: { moderationStatus: 'approved' }, orderBy: { version: 'desc' }, take: 1 },
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

    // ---------------------------------------------------------------- update
    if (action === 'update') {
      if (campaign.status === 'completed') {
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

      // Format-specific creative edits (partial — unspecified fields keep
      // their current value from the latest creative version).
      const current = campaign.creatives[0] ?? null
      const nextTitle = d.headline !== undefined ? d.headline : (current?.title ?? null)
      const nextBody = d.body !== undefined ? d.body : (current?.body ?? null)
      const nextImage = d.imageUrl !== undefined ? d.imageUrl : (current?.imageUrl ?? null)
      if (campaign.format === 'text' && (!nextTitle || !nextBody)) {
        return jsonError('Text campaigns need a headline and body copy.', 400, { code: 'creative_missing' })
      }
      if (campaign.format === 'banner' && !nextImage) {
        return jsonError('Banner campaigns need an image URL.', 400, { code: 'creative_missing' })
      }

      const updated = await db.$transaction(async (tx) => {
        const row = await tx.campaign.update({
          where: { id: campaign.id },
          data: {
            ...(d.name !== undefined ? { name: d.name } : {}),
            ...(d.bidCents !== undefined ? { bidMicroUsd: centsToMicro(d.bidCents) } : {}),
            ...(d.dailyBudgetCents !== undefined
              ? { dailyBudgetMicroUsd: centsToMicro(d.dailyBudgetCents) }
              : {}),
            ...(d.targetSections !== undefined ? { targetSections: toTargetingCsv(d.targetSections) } : {}),
            ...(d.targetLocales !== undefined ? { targetLocales: toTargetingCsv(d.targetLocales) } : {}),
          },
        })
        // Content edits append creative v+1 (append-only history). Phase 1
        // auto-approves the new version; the moderation queue is a later phase.
        const contentChanged =
          d.targetUrl !== undefined ||
          d.headline !== undefined ||
          d.body !== undefined ||
          d.imageUrl !== undefined
        const nextVersion = (current?.version ?? 0) + 1
        if (contentChanged) {
          await tx.creative.create({
            data: {
              campaignId: campaign.id,
              title: nextTitle,
              body: nextBody,
              imageUrl: nextImage,
              targetUrl: d.targetUrl ?? (current?.targetUrl ?? ''),
              version: nextVersion,
              moderationStatus: 'approved',
            },
          })
        }
        return { row, contentChanged, nextVersion }
      })
      return jsonOk({ status: 'updated', version: updated.nextVersion })
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
        //    delete can never double-refund).
        if (refundable > 0) {
          const refunded = await refundCampaignBudget(tx, {
            userId: session.user.id,
            campaignId: campaign.id,
            amountMicroUsd: refundable,
          })
          if (!refunded.ok) throw new Error('refund guard refused')
        }
        // 4. Soft delete.
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
      if (campaign.status === 'completed') {
        return jsonError('Completed campaigns cannot be paused — delete them instead.', 400)
      }
      await db.campaign.update({ where: { id }, data: { status: 'paused' } })
      return jsonOk({ status: 'paused' })
    }

    // resume: only with a derived budget that still covers one billable event
    if (campaign.status === 'completed') {
      return jsonError('Completed campaigns cannot be resumed — create a new campaign instead.', 400)
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
