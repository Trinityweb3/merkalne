import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { randomToken, sha256 } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { telegramDeepLink, telegramEnabled } from '@/lib/bots/config'
import { z } from 'zod'

/**
 * Account ⇄ Telegram linking for premium job alerts (used by /alerts).
 *
 *   POST   → issues a fresh one-time deep link (https://t.me/<bot>?start=<token>)
 *   PATCH  → { notificationsEnabled: boolean }
 *   DELETE → removes the link
 *
 * The token is random 32 bytes; only its SHA-256 hash is stored, so a database
 * leak cannot be replayed as a linking code.
 */

const patchSchema = z.object({ notificationsEnabled: z.boolean() })

export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const rl = rateLimit(`tg-link:${session.user.id}`, 10, 60_000)
    if (!rl.ok) return jsonError('Too many requests — wait a minute before generating a new code.', 429)

    if (!telegramEnabled()) {
      return jsonError(
        'Telegram alerts are not configured on this deployment (TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_USERNAME missing).',
        503,
        { code: 'bot_not_configured' },
      )
    }

    const token = randomToken(32)
    await db.telegramLink.upsert({
      where: { userId: session.user.id },
      create: { userId: session.user.id, linkTokenHash: sha256(token) },
      update: { linkTokenHash: sha256(token) },
    })

    return jsonOk({ linkUrl: telegramDeepLink(token) })
  } catch (err) {
    return handleRouteError(err)
  }
}

export async function PATCH(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const body = await req.json().catch(() => null)
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return jsonError('Invalid body', 400)

    const link = await db.telegramLink.findUnique({ where: { userId: session.user.id } })
    if (!link) return jsonError('Link Telegram first (generate a code above).', 404, { code: 'not_linked' })

    await db.telegramLink.update({
      where: { id: link.id },
      data: { notificationsEnabled: parsed.data.notificationsEnabled },
    })
    return jsonOk({ notificationsEnabled: parsed.data.notificationsEnabled })
  } catch (err) {
    return handleRouteError(err)
  }
}

export async function DELETE(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    await db.telegramLink.deleteMany({ where: { userId: session.user.id } })
    return jsonOk({ removed: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
