import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { jsonError, jsonOk } from '@/lib/api'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError } from '@/lib/api'

/**
 * POST /api/premium/subscribe — placeholder endpoint wired to every Premium
 * CTA. Stage-1 policy: purchases are NOT enabled yet, and the API says so
 * honestly (503 + explanation) instead of faking a checkout. When the stage-2
 * billing provider lands, this route becomes a real checkout-session
 * creator without any frontend changes.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`premium:${ip}`, 10, 60_000)
    if (!rl.ok) return jsonError('Too many requests', 429)

    const session = await getSession()

    return jsonError(
      session
        ? 'Premium checkout opens with the stage-2 billing launch — your account is ready and we will email you. Nothing was charged.'
        : 'Premium checkout opens with the stage-2 billing launch. Create a free account now and we will notify you first.',
      503,
      { code: 'payments_not_launched' },
    )
  } catch (err) {
    return handleRouteError(err)
  }
}
