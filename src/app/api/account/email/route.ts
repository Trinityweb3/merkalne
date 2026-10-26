import { db } from '@/lib/db'
import { getSession, issueToken, verifyPassword } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited, unauthorized } from '@/lib/api'
import { changeEmailSchema, parseJsonBody } from '@/lib/validation'
import { sendVerificationEmail } from '@/lib/email'
import { env } from '@/lib/env'

/**
 * PUT /api/account/email — requests an email change. The current password
 * must be re-supplied; the new address only takes effect after the user
 * clicks the verification link sent to it.
 */
export async function PUT(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`change-email:${ip}`, 5, 15 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const session = await getSession()
    if (!session) throw unauthorized()

    const body = await parseJsonBody(req, changeEmailSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const user = await db.user.findUnique({ where: { id: session.user.id } })
    if (!user) throw unauthorized()

    if (!user.passwordHash) {
      return jsonError('Set a password for your account before changing the email.', 400)
    }
    const valid = await verifyPassword(body.data.currentPassword, user.passwordHash)
    if (!valid) return jsonError('Current password is incorrect', 403)

    const newEmail = body.data.newEmail
    if (newEmail === user.email) {
      return jsonError('That is already your email address', 400)
    }
    const taken = await db.user.findUnique({ where: { email: newEmail } })
    if (taken) return jsonError('That email is already used by another account', 409)

    // The verification token carries the NEW address; consuming it (see the
    // verify-email page flow) performs the actual swap.
    const token = await issueToken(`change-to:${newEmail}|from:${user.id}`, 'email_verify')
    await sendVerificationEmail(
      newEmail,
      `${env.APP_URL}/auth/verify-email?token=${encodeURIComponent(token)}&change=1`,
    ).catch((e) => console.error('[change-email] email failed', e))

    return jsonOk({ pendingChange: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
