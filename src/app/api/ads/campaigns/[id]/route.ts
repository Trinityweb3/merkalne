import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { allocateWalletToCampaign, MIN_ALLOCATION_CENTS } from '@/lib/ads/wallet'
import { toTargetingCsv } from '@/lib/ads/targeting'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  action: z.enum(['pause', 'resume', 'fund', 'update']),
  /** action === 'fund': amount moved from the ad wallet into the campaign. */
  amountCents: z.coerce.number().int().min(1).max(50_000_00).optional(),
  /** action === 'update': editable campaign fields (all optional). */
  title: z.string().trim().min(3).max(80).optional(),
  body: z.string().trim().min(3).max(200).optional(),
  ctaUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//, 'The destination URL must use https')
    .optional(),
  ctaLabel: z.string().trim().max(32).optional().or(z.literal('')),
  bidPerView: z.coerce.number().int().min(1).max(50).optional(),
  targetSections: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(6).optional(),
  targetLocales: z.array(z.string().trim().toLowerCase().min(2).max(8)).max(20).optional(),
})

/**
 * PATCH /api/ads/campaigns/[id] — manage one of the advertiser's own
 * campaigns:
 *
 *   pause   stop serving (status → paused)
 *   resume  serve again — only with a balance ≥ the bid
 *   fund    move money from the ad WALLET into this campaign's budget
 *           (the BlockBee deposit itself lives in the Wallet tab)
 *   update  edit content, bid and targeting (not on ended campaigns)
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

    const campaign = await db.adCampaign.findUnique({ where: { id } })
    if (!campaign || campaign.advertiserId !== session.user.id) {
      return jsonError('Campaign not found', 404)
    }

    const { action } = parsed.data

    // ------------------------------------------------------------------ fund
    if (action === 'fund') {
      const amountCents = parsed.data.amountCents
      if (amountCents === undefined) return jsonError('amountCents is required', 400)
      if (amountCents < MIN_ALLOCATION_CENTS) {
        return jsonError('The minimum allocation is $1.00.', 400, { code: 'amount_too_small' })
      }
      const result = await allocateWalletToCampaign(session.user.id, id, amountCents)
      if (!result.ok) {
        if (result.reason === 'insufficient_wallet') {
          return jsonError(
            'Not enough money in your ad wallet — top it up in the Wallet tab first.',
            400,
            { code: 'insufficient_wallet' },
          )
        }
        return jsonError('Campaign not found', 404)
      }
      return jsonOk({
        status: campaign.status,
        balanceCents: result.campaignBalanceCents,
        walletBalanceCents: result.walletBalanceCents,
      })
    }

    // ---------------------------------------------------------------- update
    if (action === 'update') {
      if (campaign.status === 'ended') {
        return jsonError('Ended campaigns cannot be edited.', 400)
      }
      const d = parsed.data
      await db.adCampaign.update({
        where: { id },
        data: {
          ...(d.title !== undefined ? { title: d.title } : {}),
          ...(d.body !== undefined ? { body: d.body } : {}),
          ...(d.ctaUrl !== undefined ? { ctaUrl: d.ctaUrl } : {}),
          ...(d.ctaLabel !== undefined ? { ctaLabel: d.ctaLabel ? d.ctaLabel : null } : {}),
          ...(d.bidPerView !== undefined ? { bidPerView: d.bidPerView } : {}),
          ...(d.targetSections !== undefined ? { targetSections: toTargetingCsv(d.targetSections) } : {}),
          ...(d.targetLocales !== undefined ? { targetLocales: toTargetingCsv(d.targetLocales) } : {}),
        },
      })
      return jsonOk({ status: 'updated' })
    }

    // ---------------------------------------------------------- pause/resume
    if (action === 'pause') {
      await db.adCampaign.update({ where: { id }, data: { status: 'paused' } })
      return jsonOk({ status: 'paused' })
    }

    // resume
    if (campaign.balance < campaign.bidPerView) {
      return jsonError(
        'Not enough balance for one impression — add funds before resuming.',
        400,
      )
    }
    await db.adCampaign.update({ where: { id }, data: { status: 'active' } })
    return jsonOk({ status: 'active' })
  } catch (err) {
    return handleRouteError(err)
  }
}
