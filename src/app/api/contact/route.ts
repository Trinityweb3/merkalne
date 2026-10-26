import { db } from '@/lib/db'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonCreated, jsonError, jsonRateLimited } from '@/lib/api'
import { contactSchema, parseJsonBody } from '@/lib/validation'

/** POST /api/contact — public contact & report form (stored, rate limited). */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`contact:${ip}`, 5, 15 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, contactSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const message = await db.contactMessage.create({
      data: { email: body.data.email, subject: body.data.subject, body: body.data.body },
      select: { id: true },
    })

    return jsonCreated({ messageId: message.id })
  } catch (err) {
    return handleRouteError(err)
  }
}
