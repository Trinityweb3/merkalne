import { findUserByEmail, createUserFromEmail, issueToken } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonOk, jsonRateLimited } from '@/lib/api'
import { magicLinkRequestSchema, parseJsonBody } from '@/lib/validation'
import { sendMagicLinkEmail } from '@/lib/email'
import { env } from '@/lib/env'

/**
 * POST /api/auth/magic-link — passwordless sign-in.
 * Enumeration-safe: always returns the same generic response. The link signs
 * the recipient in (and provisions an account on first use, since possession
 * of the mailbox proves the identity).
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`magic:${ip}`, 6, 10 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, magicLinkRequestSchema)
    if (!body.ok) return jsonOk({ sent: true }) // generic on invalid input too

    const { email } = body.data
    let user = await findUserByEmail(email)
    if (!user) {
      user = await createUserFromEmail(email)
    }

    const token = await issueToken(email, 'magic_link')
    await sendMagicLinkEmail(email, `${env.APP_URL}/auth/magic-link?token=${encodeURIComponent(token)}`).catch(
      (e) => console.error('[magic-link] email failed', e),
    )

    return jsonOk({ sent: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
