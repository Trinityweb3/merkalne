import { z } from 'zod'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { env } from '@/lib/env'
import {
  TOPUP_MAX_CENTS,
  TOPUP_MIN_CENTS,
  deriveDepositAddress,
  topUpMode,
} from '@/lib/ads/topup'
import {
  BlockBeeApiError,
  allowedCoins,
  blockbeeConfigured,
  createPaymentIntention,
  isTronTicker,
} from '@/lib/ads/blockbee'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  /** @deprecated — deposits credit the ad WALLET, not a campaign. Accepted
   *  for backward compatibility with older dashboard bundles, ignored. */
  campaignId: z.string().trim().min(1).max(64).optional(),
  amountCents: z.coerce.number().int().min(TOPUP_MIN_CENTS).max(TOPUP_MAX_CENTS),
  /** BlockBee ticker (blockbee mode only) — validated against the allowlist */
  coin: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(24)
    .optional(),
})

/**
 * POST /api/ads/topups — start a crypto top-up of the AD WALLET: mints a
 * pending intention for the advertiser and returns the deposit address.
 * No campaign is needed — the money lands in the unified ad wallet
 * (Wallet.availableMicroUsd + a CREDIT ledger row) once confirmed and
 * campaign budgets are reserved from it later.
 *
 * blockbee mode: the address is issued by the BlockBee processor
 * (GET /{coin}/create/) — hosted, AML-screened, single-intention (the
 * callback URL embeds order_id + an unguessable nonce). The IPN webhook at
 * /api/webhooks/blockbee credits the wallet once the payment confirms
 * on-chain. The dashboard polls GET /api/ads/topups/[id] until then.
 *
 * manual/simulate modes (fallback / testing): the deterministic mock-wallet
 * address is derived locally and an admin (or, in simulate mode, the
 * advertiser) confirms.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const rl = rateLimit(`ads-topup-create:${session.user.id}`, 6, 60_000)
    if (!rl.ok) return jsonError('Too many top-up requests — try again in a minute.', 429)

    const parsed = createSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError('Invalid top-up request', 400, { issues: parsed.error.issues })
    }

    const mode = topUpMode()
    const id = crypto.randomUUID()

    if (mode === 'blockbee') {
      // ------------------------------------------------------------------
      // BlockBee: hosted payment address per intention
      // ------------------------------------------------------------------
      if (!blockbeeConfigured()) {
        return jsonError(
          'BlockBee is not configured (BLOCKBEE_API_KEY missing) — set ADS_TOPUP_MODE=manual to use the operator fallback.',
          503,
          { code: 'blockbee_not_configured' },
        )
      }
      const coin = parsed.data.coin ?? ''
      if (isTronTicker(coin)) {
        return jsonError('TRON payments are not accepted on this site.', 400, { code: 'tron_disabled' })
      }
      if (!allowedCoins().includes(coin)) {
        return jsonError('Unsupported coin — pick one of the offered networks.', 400, {
          code: 'coin_not_allowed',
        })
      }

      // The nonce binds every IPN to exactly this DB row; the order_id lets
      // the webhook find it. Both are echoed back by BlockBee verbatim.
      const callbackNonce = crypto.randomBytes(16).toString('hex')
      const callbackUrl = `${env.APP_URL}/api/webhooks/blockbee?order_id=${id}&nonce=${callbackNonce}`

      // Row first (so a payout can never reference a missing intention),
      // address filled in from the processor response right after.
      await db.cryptoTopUp.create({
        data: {
          id,
          advertiserId: session.user.id,
          walletAddress: '',
          amountExpected: parsed.data.amountCents,
          status: 'pending',
          provider: 'blockbee',
          coin,
          callbackNonce,
        },
      })

      try {
        const intention = await createPaymentIntention({ coin, callbackUrl })
        const topUp = await db.cryptoTopUp.update({
          where: { id },
          data: { walletAddress: intention.addressIn },
        })
        return jsonOk(
          {
            id: topUp.id,
            walletAddress: topUp.walletAddress,
            amountExpectedCents: topUp.amountExpected,
            status: topUp.status,
            provider: 'blockbee',
            coin: topUp.coin,
          },
          { status: 201 },
        )
      } catch (err) {
        // No address → nothing payable. Drop the intention and surface the
        // processor error (never leak internals — BlockBeeApiError messages
        // are processor-provided strings).
        await db.cryptoTopUp.delete({ where: { id } }).catch(() => undefined)
        if (err instanceof BlockBeeApiError) {
          return jsonError(`BlockBee: ${err.message}`, 502, { code: 'blockbee_error' })
        }
        throw err
      }
    }

    // ----------------------------------------------------------------------
    // manual / simulate: deterministic mock address (fallback for testing)
    // ----------------------------------------------------------------------
    const topUp = await db.cryptoTopUp.create({
      data: {
        id,
        advertiserId: session.user.id,
        // The id is supplied (uuid) so the deposit address can be derived
        // from it BEFORE the row is written — one insert, no placeholder dance.
        walletAddress: deriveDepositAddress(id),
        amountExpected: parsed.data.amountCents,
        status: 'pending',
        provider: 'manual',
      },
    })

    return jsonOk(
      {
        id: topUp.id,
        walletAddress: topUp.walletAddress,
        amountExpectedCents: topUp.amountExpected,
        status: topUp.status,
        provider: 'manual',
        coin: null,
      },
      { status: 201 },
    )
  } catch (err) {
    return handleRouteError(err)
  }
}
