import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, topUpMode } from '@/lib/ads/topup'
import { allowedCoins } from '@/lib/ads/blockbee'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads/wallet — the advertiser's Wallet tab in one round-trip:
 *
 *   balanceCents     money in the ad wallet (User.adBalance)
 *   inCampaignsCents sum of active/paused campaign flight budgets
 *   pendingCents     sum of unconfirmed deposit intentions
 *   topUps           the last 20 deposit intentions (transaction history)
 *   topUp            processor config (mode, coins, limits) so the deposit
 *                    modal can render the right flow without a second call
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const [user, campaigns, topUps] = await Promise.all([
      db.user.findUnique({
        where: { id: session.user.id },
        select: { adBalance: true },
      }),
      db.adCampaign.findMany({
        where: { advertiserId: session.user.id, status: { in: ['active', 'paused'] } },
        select: { balance: true },
      }),
      db.cryptoTopUp.findMany({
        where: { advertiserId: session.user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ])

    const pending = topUps
      .filter((t) => t.status === 'pending')
      .reduce((sum, t) => sum + t.amountExpected, 0)

    return jsonOk({
      balanceCents: user?.adBalance ?? 0,
      inCampaignsCents: campaigns.reduce((sum, c) => sum + c.balance, 0),
      pendingCents: pending,
      topUps: topUps.map((t) => ({
        id: t.id,
        status: t.status,
        amountExpectedCents: t.amountExpected,
        amountReceivedCents: t.amountReceived,
        provider: t.provider,
        coin: t.coin,
        txHash: t.txHash,
        createdAt: t.createdAt.toISOString(),
        confirmedAt: t.confirmedAt?.toISOString() ?? null,
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
