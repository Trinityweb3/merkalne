import { createSession, findUserByEmail, verifyPassword } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited } from '@/lib/api'
import { loginSchema, parseJsonBody } from '@/lib/validation'

/**
 * POST /api/auth/login — email + password sign-in.
 * Rate limited per IP; always the same generic error for bad credentials so
 * the endpoint cannot be used to enumerate accounts.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`login:${ip}`, 10, 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, loginSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const { email, password } = body.data
    const user = await findUserByEmail(email)

    // Constant-ish work whether or not the account exists.
    const hash = user?.passwordHash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEe.O0000000000000000000000000000000'
    const valid = await verifyPassword(password, hash)

    if (!user || !user.passwordHash || !valid) {
      return jsonError('Invalid email or password', 401)
    }

    await createSession(user.id, { userAgent: req.headers.get('user-agent'), ip })

    return jsonOk({
      user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified !== null },
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
