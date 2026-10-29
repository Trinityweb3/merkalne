import { z } from 'zod'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { allowedCoins, blockbeeConfigured, isTronTicker } from '@/lib/ads/blockbee'
import { createPremiumCheckout } from '@/lib/premium/orders'
import { PLAN_PRICING, type BillingPeriod, type PremiumPlan } from '@/lib/premium/plan'

export const dynamic = 'force-dynamic'

const checkoutSchema = z.object({
  /** "premium" | "premium_plus" */
  plan: z.enum(['premium', 'premium_plus']),
  /** "monthly" | "yearly" */
  period: z.enum(['monthly', 'yearly']),
  /** BlockBee ticker — validated against the allowlist */
  coin: z.string().trim().toLowerCase().min(2).max(24),
})

/**
 * POST /api/premium/checkout — start a Premium / Premium+ subscription
 * payment through BlockBee.
 *
 * Creates a pending PremiumOrder whose id IS the BlockBee order_id and
 * carries the routing prefix (prem_m_<userId>_… / prem_y_ / premplus_m_ /
 * premplus_y_), issues a hosted payment address for the chosen coin and
 * returns it. The exact price (US cents) comes from the server-side catalog
 * (PLAN_PRICING) — the client never sends an amount, so prices cannot be
 * tampered with. The IPN webhook at /api/webhooks/blockbee confirms the
 * payment and extends plan + premiumUntil; the UI polls
 * GET /api/premium/checkout/[id] until then.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Sign in to subscribe', 401)

    const rl = rateLimit(`premium-checkout:${session.user.id}`, 6, 60_000)
    if (!rl.ok) return jsonError('Too many checkout requests — try again in a minute.', 429)

    const parsed = checkoutSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError('Invalid checkout request', 400, { issues: parsed.error.issues })
    }

    if (!blockbeeConfigured()) {
      return jsonError(
        'Crypto checkout is not configured on this deployment yet (BLOCKBEE_API_KEY missing).',
        503,
        { code: 'blockbee_not_configured' },
      )
    }

    const coin = parsed.data.coin
    if (isTronTicker(coin)) {
      return jsonError('TRON payments are not accepted on this site.', 400, { code: 'tron_disabled' })
    }
    if (!allowedCoins().includes(coin)) {
      return jsonError('Unsupported coin — pick one of the offered networks.', 400, {
        code: 'coin_not_allowed',
      })
    }

    const result = await createPremiumCheckout(
      session.user,
      parsed.data.plan as PremiumPlan,
      parsed.data.period as BillingPeriod,
      coin,
    )
    if (!result.ok) {
      return jsonError(result.message, result.status, { code: result.code })
    }
    return jsonOk(result.checkout, { status: 201 })
  } catch (err) {
    return handleRouteError(err)
  }
}

/**
 * GET /api/premium/checkout — public checkout config for the pricing page:
 * which coins are offered and the server-side price catalog (so the UI and
 * the charge can never disagree).
 */
export async function GET() {
  return jsonOk({
    configured: blockbeeConfigured(),
    coins: allowedCoins(),
    pricing: {
      premium: {
        monthlyCents: PLAN_PRICING.premium.monthlyCents,
        yearlyCents: PLAN_PRICING.premium.yearlyCents,
      },
      premium_plus: {
        monthlyCents: PLAN_PRICING.premium_plus.monthlyCents,
        yearlyCents: PLAN_PRICING.premium_plus.yearlyCents,
      },
    },
  })
}
