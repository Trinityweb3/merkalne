import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { getSession } from '@/lib/auth'
import { confirmTopUp, topUpMode } from '@/lib/ads/topup'

export const dynamic = 'force-dynamic'

/**
 * POST /api/ads/topups/[id]/simulate — DEMO PATH ONLY (ADS_TOPUP_MODE=simulate).
 *
 * Marks the advertiser's own PENDING top-up as paid and credits the ad
 * wallet — without any real chain observation. This exists so the whole
 * auction loop can be demonstrated and tested end-to-end while no payment
 * provider is wired in. The route hard-fails with 403 whenever
 * ADS_TOPUP_MODE is not "simulate" (in "manual" an ADMIN confirms deposits
 * via /api/admin/ads/topups/[id]/confirm instead).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    if (topUpMode() !== 'simulate') {
      return jsonError(
        'Simulation is disabled — deposits are confirmed by the site operator in this mode.',
        403,
        { code: 'simulate_disabled' },
      )
    }

    const { id } = await ctx.params
    const topUp = await db.cryptoTopUp.findUnique({ where: { id } })
    if (!topUp || topUp.advertiserId !== session.user.id) {
      return jsonError('Top-up not found', 404)
    }

    const result = await confirmTopUp(id)
    if (!result.ok) {
      return jsonError(
        result.reason === 'already_confirmed'
          ? 'This top-up is already confirmed.'
          : 'Top-up not found.',
        400,
      )
    }
    return jsonOk({ status: 'confirmed', creditedCents: result.creditedCents })
  } catch (err) {
    return handleRouteError(err)
  }
}
