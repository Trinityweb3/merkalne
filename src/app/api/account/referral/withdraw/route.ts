import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { logPayment } from '@/lib/payment-log'
import {
  BlockBeeApiError,
  allowedCoins,
  blockbeeConfigured,
  convertUsdToCoin,
  createPayoutFromRequests,
  createPayoutRequest,
  isTronTicker,
  minWithdrawCents,
  processPayout,
} from '@/lib/ads/blockbee'

export const dynamic = 'force-dynamic'

const withdrawSchema = z.object({
  coin: z.string().trim().toLowerCase().min(2).max(24),
  address: z
    .string()
    .trim()
    .min(20, 'address looks too short')
    .max(120, 'address looks too long')
    .regex(/^[a-zA-Z0-9:.\-]+$/, 'address contains invalid characters'),
  /** US cents; omitted → withdraw the entire available balance */
  amountCents: z.coerce.number().int().min(1).max(10_000_000).optional(),
})

/**
 * POST /api/account/referral/withdraw — pay out (part of) the referral
 * balance to the user's own crypto address through the BlockBee payout
 * chain:
 *
 *   1. validate (auth, coin allowlist — TRON banned, address shape, amount,
 *      single-active-withdrawal guard)
 *   2. ReferralWithdrawal row created FIRST (status "pending") so a payout
 *      can never reference a missing ledger row
 *   3. GET /{coin}/payout/request/create/ → payout REQUEST (nothing sent)
 *   4. POST /payout/create/  → payout id   (persisted BEFORE processing,
 *      so even a crash between create and process keeps the row linkable)
 *   5. POST /payout/process/ → broadcast   (row → "processing")
 *
 * The user's referralBalance is NOT touched here — it is deducted only when
 * the payout webhook confirms status=done on-chain. Failed/expired payouts
 * leave the balance intact. Any BlockBee error marks the row failed with
 * the processor's message surfaced to the user.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    // 6 attempts per 3 h — enough to survive a few wrong-coin/minimum
    // retries, tight enough to stop balance-probing spam.
    const rl = rateLimit(`referral-withdraw:${session.user.id}`, 6, 3 * 3_600_000)
    if (!rl.ok) {
      return jsonError('Too many withdrawal requests — try again later.', 429)
    }

    if (!blockbeeConfigured()) {
      return jsonError(
        'Crypto payouts are not enabled on this deployment yet (BLOCKBEE_API_KEY missing).',
        503,
        { code: 'payouts_not_configured' },
      )
    }

    const parsed = withdrawSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError('Invalid withdrawal request', 400, { issues: parsed.error.issues })
    }
    const { coin, address } = parsed.data

    if (isTronTicker(coin)) {
      return jsonError('TRON payouts are not available on this site.', 400, { code: 'tron_disabled' })
    }
    if (!allowedCoins().includes(coin)) {
      return jsonError('Unsupported coin — pick one of the offered networks.', 400, {
        code: 'coin_not_allowed',
      })
    }

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { referralBalance: true },
    })
    const balance = user?.referralBalance ?? 0
    const amountCents = parsed.data.amountCents ?? balance
    if (amountCents < minWithdrawCents()) {
      return jsonError(`Minimum withdrawal is $${(minWithdrawCents() / 100).toFixed(2)}.`, 400, {
        code: 'below_minimum',
      })
    }
    if (amountCents > balance) {
      return jsonError('Amount exceeds your available referral balance.', 400, {
        code: 'insufficient_balance',
      })
    }

    // Single active withdrawal per user — prevents stacking payouts against
    // the same balance while one is still in flight.
    const active = await db.referralWithdrawal.findFirst({
      where: { userId: session.user.id, status: { in: ['pending', 'processing'] } },
      select: { id: true },
    })
    if (active) {
      return jsonError(
        'You already have a withdrawal in progress — it must finish before the next one.',
        409,
        { code: 'withdrawal_in_progress' },
      )
    }

    // Ledger row FIRST — every later step updates it, so a crash at any
    // point leaves an auditable trail instead of a dangling payout.
    const withdrawal = await db.referralWithdrawal.create({
      data: { userId: session.user.id, amountCents, coin, address, status: 'pending' },
    })

    try {
      // USD → coin conversion (processor price feed).
      const usd = amountCents / 100
      const { coinAmount } = await convertUsdToCoin(coin, usd)
      await db.referralWithdrawal.update({
        where: { id: withdrawal.id },
        data: { coinAmount },
      })

      // Payout request → payout → broadcast.
      const requestId = await createPayoutRequest(coin, address, coinAmount)
      await db.referralWithdrawal.update({
        where: { id: withdrawal.id },
        data: { payoutRequestId: requestId },
      })

      const payout = await createPayoutFromRequests([requestId])
      await db.referralWithdrawal.update({
        where: { id: withdrawal.id },
        data: { payoutId: payout.id },
      })

      const processed = await processPayout(payout.id)
      const final = await db.referralWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: processed.status === 'created' ? 'pending' : 'processing',
        },
      })

      await logPayment({
        source: 'referral_withdraw',
        event: 'payout_submitted',
        ok: true,
        externalId: payout.id,
        referenceId: withdrawal.id,
        userId: session.user.id,
        amountCents,
        detail: { coin, address, coinAmount, payoutStatus: processed.status },
      })

      return jsonOk({
        id: final.id,
        amountCents: final.amountCents,
        coin: final.coin,
        coinAmount: final.coinAmount,
        address: final.address,
        payoutId: payout.id,
        status: final.status,
      })
    } catch (err) {
      // Nothing was broadcast (any failure happened before/at process) —
      // the balance is untouched. Surface the processor's own message.
      const message = err instanceof BlockBeeApiError ? err.message : 'Payout request failed'
      await db.referralWithdrawal.update({
        where: { id: withdrawal.id, status: 'pending' },
        data: { status: 'failed', error: message },
      })
      await logPayment({
        source: 'referral_withdraw',
        event: 'payout_failed',
        ok: false,
        referenceId: withdrawal.id,
        userId: session.user.id,
        amountCents,
        detail: { error: message.slice(0, 300) },
      })
      if (err instanceof BlockBeeApiError) {
        return jsonError(`BlockBee: ${message}`, 502, { code: 'blockbee_error' })
      }
      throw err
    }
  } catch (err) {
    return handleRouteError(err)
  }
}
