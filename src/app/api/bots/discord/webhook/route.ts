import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { isDiscordWebhookUrl, maskDiscordWebhook } from '@/lib/bots/discord'
import { encryptSecret } from '@/lib/bots/secretbox'
import { z } from 'zod'

/**
 * Personal Discord webhook for premium job alerts (used by /alerts).
 *
 *   POST   → { url, label? } — validate + AES-256-GCM encrypt + upsert
 *   PATCH  → { notificationsEnabled: boolean }
 *   DELETE → remove
 *
 * Users paste an incoming-webhook URL from their OWN Discord server
 * (Server Settings → Integrations → Webhooks → New Webhook → Copy URL).
 * The URL is validated against the exact Discord webhook shape and stored
 * encrypted at rest (key derived from AUTH_SECRET); responses only ever show
 * the masked form.
 */

const postSchema = z.object({
  url: z.string().trim().min(30).max(512),
  label: z.string().trim().max(80).optional(),
})

const patchSchema = z.object({ notificationsEnabled: z.boolean() })

export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const rl = rateLimit(`discord-hook:${session.user.id}`, 10, 60_000)
    if (!rl.ok) return jsonError('Too many requests', 429)

    const body = await req.json().catch(() => null)
    const parsed = postSchema.safeParse(body)
    if (!parsed.success) return jsonError('Invalid body', 400)

    if (!isDiscordWebhookUrl(parsed.data.url)) {
      return jsonError(
        'That is not a Discord webhook URL. Create one in your server: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
        400,
        { code: 'invalid_webhook' },
      )
    }

    const urlEnc = encryptSecret(parsed.data.url)
    const existing = await db.discordWebhook.findUnique({ where: { userId: session.user.id } })
    if (existing) {
      await db.discordWebhook.update({
        where: { id: existing.id },
        data: { urlEnc, label: parsed.data.label ?? existing.label },
      })
    } else {
      await db.discordWebhook.create({
        data: { userId: session.user.id, urlEnc, label: parsed.data.label ?? null },
      })
    }

    return jsonOk({ masked: maskDiscordWebhook(parsed.data.url), label: parsed.data.label ?? null })
  } catch (err) {
    if (err instanceof Error && err.message.includes('AUTH_SECRET')) {
      return jsonError(err.message, 500, { code: 'auth_secret_missing' })
    }
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

    const hook = await db.discordWebhook.findUnique({ where: { userId: session.user.id } })
    if (!hook) return jsonError('Add a webhook first.', 404, { code: 'not_configured' })

    await db.discordWebhook.update({
      where: { id: hook.id },
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

    await db.discordWebhook.deleteMany({ where: { userId: session.user.id } })
    return jsonOk({ removed: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
