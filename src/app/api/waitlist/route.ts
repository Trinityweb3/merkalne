import { db } from '@/lib/db'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonCreated, jsonError, jsonOk, jsonRateLimited } from '@/lib/api'
import { parseJsonBody, waitlistSchema } from '@/lib/validation'
import { sendWaitlistConfirmation } from '@/lib/email'

/**
 * POST /api/waitlist — Merklane Ads launch waitlist capture.
 * Idempotent per email: re-subscribing returns the same friendly answer
 * without sending a duplicate confirmation.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`waitlist:${ip}`, 6, 10 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, waitlistSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const { email, source } = body.data
    const existing = await db.waitlistEntry.findUnique({ where: { email } })

    if (!existing) {
      await db.waitlistEntry.create({ data: { email, source } })
      await sendWaitlistConfirmation(email).catch((e) =>
        console.error('[waitlist] confirmation email failed', e),
      )
      return jsonCreated({ joined: true, alreadyOnList: false })
    }

    return jsonOk({ joined: true, alreadyOnList: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
