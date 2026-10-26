import { findUserByEmail, issueToken } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonOk, jsonRateLimited } from '@/lib/api'
import { forgotPasswordSchema, parseJsonBody } from '@/lib/validation'
import { sendPasswordResetEmail } from '@/lib/email'
import { env } from '@/lib/env'

/**
 * POST /api/auth/forgot-password — requests a reset link.
 * Enumeration-safe: the response is identical whether or not the account
 * exists. Tokens are single-use, hashed server-side and expire in 60 minutes.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`forgot:${ip}`, 5, 15 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, forgotPasswordSchema)
    if (!body.ok) return jsonOk({ sent: true })

    const user = await findUserByEmail(body.data.email)
    if (user) {
      const token = await issueToken(user.email, 'password_reset')
      await sendPasswordResetEmail(
        user.email,
        `${env.APP_URL}/auth/reset-password?token=${encodeURIComponent(token)}`,
      ).catch((e) => console.error('[forgot-password] email failed', e))
    }

    return jsonOk({ sent: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
