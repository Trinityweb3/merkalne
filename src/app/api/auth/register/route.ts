import { db } from '@/lib/db'
import { createSession, findUserByEmail, hashPassword } from '@/lib/auth'
import { issueToken } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonCreated, jsonError, jsonRateLimited } from '@/lib/api'
import { parseJsonBody, registerSchema } from '@/lib/validation'
import { sendVerificationEmail } from '@/lib/email'
import { env } from '@/lib/env'

/**
 * POST /api/auth/register — email + password sign-up.
 * Creates the account, signs the user in and emails a one-time verification
 * link. The verification email failure must never break the registration.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`register:${ip}`, 5, 10 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, registerSchema)
    if (!body.ok) return jsonError(body.message, 422, { issues: body.issues })

    const { email, password, name } = body.data

    const existing = await findUserByEmail(email)
    if (existing) {
      return jsonError('An account with this email already exists. Try signing in instead.', 409)
    }

    const passwordHash = await hashPassword(password)
    const user = await db.user.create({
      data: { email, passwordHash, name: name ?? null },
    })

    await createSession(user.id, {
      userAgent: req.headers.get('user-agent'),
      ip,
    })

    const token = await issueToken(email, 'email_verify')
    await sendVerificationEmail(
      email,
      `${env.APP_URL}/auth/verify-email?token=${encodeURIComponent(token)}`,
    ).catch((e) => console.error('[register] verification email failed', e))

    return jsonCreated({
      user: { id: user.id, email: user.email, name: user.name, emailVerified: false },
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
