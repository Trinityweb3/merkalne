import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { getOrCreateWallet } from '@/lib/ads/wallet'
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, topUpMode } from '@/lib/ads/topup'
import { allowedCoins } from '@/lib/ads/blockbee'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads/wallet — the advertiser's Wallet tab in one round-trip:
 *
 *   availableMicroUsd   spendable balance of the unified wallet
 *   reservedMicroUsd    money committed to campaign budgets (unspent)
 *   pendingCents        sum of unconfirmed deposit intentions (cents — the
 *                       BlockBee domain keeps cents; the wallet is micro-USD)
 *   ledger              the last 20 immutable ledger movements (the
 *                       double-entry trail: credit / reserve / charge / refund)
 *   topUps              the last 20 deposit intentions (BlockBee history)
 *   topUp               processor config (mode, coins, limits)
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const wallet = await getOrCreateWallet(session.user.id)
    const [topUps, ledger, campaignRows] = await Promise.all([
      db.cryptoTopUp.findMany({
        where: { advertiserId: session.user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      db.ledgerEntry.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      db.campaign.findMany({
        where: { advertiserId: session.user.id },
        select: { id: true, name: true },
      }),
    ])

    const pending = topUps
      .filter((t) => t.status === 'pending')
      .reduce((sum, t) => sum + t.amountExpected, 0)
    const campaignNames = new Map(campaignRows.map((c) => [c.id, c.name] as const))

    return jsonOk({
      availableMicroUsd: wallet.availableMicroUsd,
      reservedMicroUsd: wallet.reservedMicroUsd,
      pendingCents: pending,
      ledger: ledger.map((row) => ({
        id: row.id,
        type: row.type,
        amountMicroUsd: row.amountMicroUsd,
        campaignId: row.campaignId,
        campaignName: row.campaignId ? (campaignNames.get(row.campaignId) ?? null) : null,
        eventId: row.eventId,
        createdAt: row.createdAt.toISOString(),
      })),
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
