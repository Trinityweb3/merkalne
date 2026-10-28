import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { env } from '@/lib/env'
import { ensureReferralCode, referralLink } from '@/lib/referral'
import { allowedCoins, blockbeeConfigured, minWithdrawCents } from '@/lib/ads/blockbee'

export const dynamic = 'force-dynamic'

/**
 * GET /api/account/referral — the signed-in user's referral cabinet data:
 * shareable link + code, live balance, lifetime stats, referred-by info and
 * the withdrawal history. Also carries everything the withdraw form needs
 * (offered coins, minimum, whether payouts are enabled at all).
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const userId = session.user.id
    const code = await ensureReferralCode(userId)

    const [user, referredCount, earnedAgg, withdrawnAgg, withdrawals, referredBy] =
      await Promise.all([
        db.user.findUnique({
          where: { id: userId },
          select: { referralBalance: true, referredById: true },
        }),
        db.user.count({ where: { referredById: userId } }),
        db.paymentLog.aggregate({
          where: { source: 'referral_commission', userId, event: 'commission_credited' },
          _sum: { amountCents: true },
        }),
        db.referralWithdrawal.aggregate({
          where: { userId, status: { in: ['pending', 'processing', 'done'] } },
          _sum: { amountCents: true },
        }),
        db.referralWithdrawal.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        db.user.findUnique({
          where: { id: userId },
          select: { referredBy: { select: { name: true, referralCode: true } } },
        }),
      ])

    return jsonOk({
      referralCode: code,
      referralLink: referralLink(code, env.APP_URL),
      referralBalanceCents: user?.referralBalance ?? 0,
      referredCount,
      earnedTotalCents: earnedAgg._sum.amountCents ?? 0,
      withdrawnCents: withdrawnAgg._sum.amountCents ?? 0,
      referredBy: referredBy?.referredBy
        ? { name: referredBy.referredBy.name, code: referredBy.referredBy.referralCode }
        : null,
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        amountCents: w.amountCents,
        coin: w.coin,
        address: w.address,
        status: w.status,
        error: w.error,
        createdAt: w.createdAt.toISOString(),
        completedAt: w.completedAt?.toISOString() ?? null,
      })),
      withdraw: {
        enabled: blockbeeConfigured(),
        coins: allowedCoins(),
        minCents: minWithdrawCents(),
      },
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
