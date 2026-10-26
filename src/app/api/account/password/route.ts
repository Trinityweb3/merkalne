import { db } from '@/lib/db'
import { getSession, hashPassword, verifyPassword, createSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited, unauthorized } from '@/lib/api'
import { changePasswordSchema, parseJsonBody } from '@/lib/validation'

/**
 * PUT /api/account/password — changes the password after re-authenticating
 * with the current one. Other sessions stay valid (only the reset flow signs
 * out everywhere); a fresh session cookie keeps this browser logged in.
 */
export async function PUT(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`change-pw:${ip}`, 5, 15 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const session = await getSession()
    if (!session) throw unauthorized()

    const body = await parseJsonBody(req, changePasswordSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const user = await db.user.findUnique({ where: { id: session.user.id } })
    if (!user?.passwordHash) {
      return jsonError('This account has no password set yet. Use "Set password" in Security.', 400)
    }

    const valid = await verifyPassword(body.data.currentPassword, user.passwordHash)
    if (!valid) return jsonError('Current password is incorrect', 403)

    const passwordHash = await hashPassword(body.data.newPassword)
    await db.user.update({ where: { id: user.id }, data: { passwordHash } })

    // Rotate this browser's session (issuing a new token) after the change.
    await db.session.deleteMany({ where: { userId: user.id, id: session.sessionId } })
    await createSession(user.id, { userAgent: req.headers.get('user-agent'), ip })

    return jsonOk({ changed: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
