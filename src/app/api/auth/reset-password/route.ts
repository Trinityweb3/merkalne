import { db } from '@/lib/db'
import { consumeToken, hashPassword, revokeAllSessions } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited } from '@/lib/api'
import { parseJsonBody, resetPasswordSchema } from '@/lib/validation'

/**
 * POST /api/auth/reset-password — consumes a reset token, sets the new
 * password and revokes every existing session (sign-out everywhere).
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`reset:${ip}`, 10, 15 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, resetPasswordSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const { sha256 } = await import('@/lib/csrf')
    const record = await db.verificationToken.findUnique({
      where: { tokenHash: sha256(body.data.token) },
    })
    if (!record || record.type !== 'password_reset') {
      return jsonError('Invalid or expired reset link.', 400)
    }

    const result = await consumeToken(body.data.token, 'password_reset')
    if (!result.ok) {
      return jsonError(
        result.reason === 'expired'
          ? 'This reset link has expired. Request a new one.'
          : 'This reset link was already used.',
        400,
      )
    }

    const user = await db.user.findUnique({ where: { email: record.identifier } })
    if (!user) return jsonError('Invalid or expired reset link.', 400)

    const passwordHash = await hashPassword(body.data.password)
    await db.$transaction([
      db.user.update({ where: { id: user.id }, data: { passwordHash } }),
      // Security: invalidate every existing session after a password change.
      db.session.deleteMany({ where: { userId: user.id } }),
    ])

    return jsonOk({ reset: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
