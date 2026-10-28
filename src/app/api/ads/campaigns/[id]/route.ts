import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  action: z.enum(['pause', 'resume']),
})

/**
 * PATCH /api/ads/campaigns/[id] — pause or resume one of the advertiser's
 * own campaigns. Resuming is only allowed with a positive balance (an empty
 * campaign stays paused until a top-up lands).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const { id } = await ctx.params
    const parsed = patchSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return jsonError('Invalid action', 400)

    const rl = rateLimit(`ads-campaign-patch:${session.user.id}`, 20, 60_000)
    if (!rl.ok) return jsonError('Too many updates — try again in a minute.', 429)

    const campaign = await db.adCampaign.findUnique({ where: { id } })
    if (!campaign || campaign.advertiserId !== session.user.id) {
      return jsonError('Campaign not found', 404)
    }

    if (parsed.data.action === 'pause') {
      await db.adCampaign.update({ where: { id }, data: { status: 'paused' } })
      return jsonOk({ status: 'paused' })
    }

    // resume
    if (campaign.balance < campaign.bidPerView) {
      return jsonError(
        'Not enough balance for one impression — top up before resuming.',
        400,
      )
    }
    await db.adCampaign.update({ where: { id }, data: { status: 'active' } })
    return jsonOk({ status: 'active' })
  } catch (err) {
    return handleRouteError(err)
  }
}
