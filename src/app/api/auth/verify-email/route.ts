import { db } from '@/lib/db'
import { consumeToken } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited } from '@/lib/api'
import { parseJsonBody, verifyEmailSchema } from '@/lib/validation'

/** POST /api/auth/verify-email — consumes a one-time email verification token. */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`verify-email:${ip}`, 12, 10 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, verifyEmailSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const { sha256 } = await import('@/lib/csrf')
    const record = await db.verificationToken.findUnique({
      where: { tokenHash: sha256(body.data.token) },
    })
    if (!record || record.type !== 'email_verify') return jsonError('Invalid verification link.', 400)

    const result = await consumeToken(body.data.token, 'email_verify')
    if (!result.ok) {
      return jsonError(
        result.reason === 'expired'
          ? 'This verification link has expired. Request a new one from your profile.'
          : 'This verification link was already used.',
        400,
      )
    }

    await db.user.update({
      where: { email: record.identifier },
      data: { emailVerified: new Date() },
    })

    return jsonOk({ verified: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
