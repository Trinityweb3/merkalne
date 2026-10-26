import { createSession, consumeToken, findUserByEmail, createUserFromEmail } from '@/lib/auth'
import { sha256 } from '@/lib/csrf'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited } from '@/lib/api'
import { magicLinkVerifySchema, parseJsonBody } from '@/lib/validation'
import { db } from '@/lib/db'

/**
 * POST /api/auth/magic-link/verify — consumes a one-time magic link token.
 * Possession of the link proves mailbox ownership, so the account is marked
 * email-verified at the same time.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`magic-verify:${ip}`, 12, 10 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, magicLinkVerifySchema)
    if (!body.ok) return jsonError(body.message, 422)

    // Look up the identifier bound to this token before consuming it.
    const record = await db.verificationToken.findUnique({
      where: { tokenHash: sha256(body.data.token) },
    })
    if (!record || record.type !== 'magic_link') {
      return jsonError('Invalid sign-in link.', 400)
    }

    const result = await consumeToken(body.data.token, 'magic_link')
    if (!result.ok) {
      const message =
        result.reason === 'expired'
          ? 'This sign-in link has expired. Request a new one.'
          : 'This sign-in link was already used. Request a new one.'
      return jsonError(message, 400)
    }

    let user = await findUserByEmail(record.identifier)
    if (!user) {
      user = await createUserFromEmail(record.identifier, { emailVerified: true })
    } else if (!user.emailVerified) {
      user = await db.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date() },
      })
    }

    await createSession(user.id, { userAgent: req.headers.get('user-agent'), ip })

    return jsonOk({ user: { id: user.id, email: user.email, name: user.name } })
  } catch (err) {
    return handleRouteError(err)
  }
}
