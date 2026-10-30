import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { topUpMode } from '@/lib/ads/topup'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads/topups/[id] — status polling for one of the advertiser's own
 * top-ups (the dashboard pings this every few seconds while a payment is
 * pending). Exposes the deposit address, expected/confirmed amounts and the
 * confirmation mode/provider so the UI can show the right hint. The
 * callbackNonce is deliberately NEVER returned — it is a server-side webhook
 * authenticator, not client data.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const { id } = await ctx.params
    const topUp = await db.cryptoTopUp.findUnique({ where: { id } })
    if (!topUp || topUp.advertiserId !== session.user.id) {
      return jsonError('Top-up not found', 404)
    }

    return jsonOk({
      id: topUp.id,
      status: topUp.status,
      walletAddress: topUp.walletAddress,
      amountExpectedCents: topUp.amountExpected,
      amountReceivedCents: topUp.amountReceived,
      mode: topUpMode(),
      provider: topUp.provider,
      coin: topUp.coin,
      txHash: topUp.txHash,
      createdAt: topUp.createdAt.toISOString(),
      confirmedAt: topUp.confirmedAt?.toISOString() ?? null,
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
