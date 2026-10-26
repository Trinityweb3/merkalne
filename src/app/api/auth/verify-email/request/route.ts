import { getSession, issueToken } from '@/lib/auth'
import { findUserByEmail } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited } from '@/lib/api'
import { emailSchema, parseJsonBody } from '@/lib/validation'
import { sendVerificationEmail } from '@/lib/email'
import { env } from '@/lib/env'
import { z } from 'zod'

/**
 * POST /api/auth/verify-email/request — re-sends the verification email.
 * Accepts { email } for the pre-login banner and no body for the signed-in
 * profile screen. Always answers generically when the account is unknown.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`verify-request:${ip}`, 4, 15 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const schema = z.object({ email: emailSchema.optional() })
    const body = await parseJsonBody(req, schema)
    if (!body.ok) return jsonError(body.message, 422)

    let email = body.data.email
    if (!email) {
      const session = await getSession()
      if (!session) return jsonError('Authentication required', 401)
      email = session.user.email
    }

    const user = await findUserByEmail(email)
    if (!user || user.emailVerified) {
      return jsonOk({ sent: true })
    }

    const token = await issueToken(email, 'email_verify')
    await sendVerificationEmail(
      email,
      `${env.APP_URL}/auth/verify-email?token=${encodeURIComponent(token)}`,
    ).catch((e) => console.error('[verify-email/request] email failed', e))

    return jsonOk({ sent: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
