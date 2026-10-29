import { db } from '@/lib/db'
import { jsonError, jsonOk } from '@/lib/api'
import { rateLimit } from '@/lib/rate-limit'
import { sha256 } from '@/lib/csrf'
import { botEnv, telegramAdminIds, telegramWebhookConfigured } from '@/lib/bots/config'
import { parseTelegramCommand, telegramSendMessage, type TelegramUpdate } from '@/lib/bots/telegram'
import { isPremiumActive, planDisplayName } from '@/lib/premium/plan'

/**
 * POST /api/webhooks/telegram — the user-facing NOTIFIER BOT webhook.
 *
 * Role after the bot split (see /api/webhooks/telegram-admin):
 *   THIS bot (TELEGRAM_BOT_TOKEN)                     admin intake bot
 *   ─ /start <token> — link a web account             (TELEGRAM_ADMIN_BOT_TOKEN)
 *   ─ /alerts on|off — pause/resume DMs               ─ job composer wizard
 *   ─ /unlink · /whoami · /help                       ─ /jobs /publish /stats
 *   ─ premium alert DMs (sent by the worker)          ─ /grant /revoke
 *
 * Security model (server-to-server — CSRF is not applicable):
 *   • every request must carry the X-Telegram-Bot-Api-Secret-Token header set
 *     via setWebhook (compared against TELEGRAM_WEBHOOK_SECRET)
 *   • per-chat sliding-window rate limit
 *   • every link/unlink lands in IngestionLog
 *
 * Always answers 200 to Telegram (error text is sent as the bot reply) so the
 * Bot API does not retry user mistakes.
 */

const HELP_TEXT = [
  '<b>Merklane notifier bot</b>',
  '',
  'I send premium job alerts to this chat.',
  '',
  '<b>Your alerts</b>',
  '/start — link your account (code from the alerts page)',
  '/alerts on|off — pause or resume DMs',
  '/unlink — disconnect this chat',
  '/whoami — show the linked account',
  '',
  'Job publishing happens in the separate admin intake bot.',
].join('\n')

export async function POST(req: Request) {
  // 1. Webhook authentication — the secret token Telegram echoes on every call.
  if (!telegramWebhookConfigured()) {
    return jsonError('Telegram webhook is not configured (TELEGRAM_WEBHOOK_SECRET missing).', 503, { code: 'bot_not_configured' })
  }
  const provided = req.headers.get('x-telegram-bot-api-secret-token') ?? ''
  if (provided !== botEnv.TELEGRAM_WEBHOOK_SECRET) {
    return jsonError('Forbidden', 403)
  }

  // 2. Shape check + per-chat rate limit.
  let update: TelegramUpdate
  try {
    update = (await req.json()) as TelegramUpdate
  } catch {
    return jsonError('Invalid JSON body', 400)
  }
  if (!update?.message?.chat || !update.message.text) {
    return jsonOk({ ignored: true }) // channel posts, edits, callback queries, etc.
  }

  const msg = update.message
  const chatId = String(msg.chat.id)

  const rl = rateLimit(`tg-webhook:${chatId}`, 20, 60_000)
  if (!rl.ok) return jsonOk({ ignored: true, reason: 'rate_limited' })

  const parsedCommand = parseTelegramCommand(msg.text)
  if (!parsedCommand) {
    await reply(chatId, 'Commands start with <b>/</b>. Send /help for what I can do.')
    return jsonOk({ handled: true })
  }
  const { command, args } = parsedCommand

  // The notifier bot is user-facing: nothing here is admin-gated. The admin
  // surface lives in the SEPARATE admin intake bot (TELEGRAM_ADMIN_BOT_TOKEN,
  // webhook /api/webhooks/telegram-admin, allowlist TELEGRAM_ADMIN_USER_IDS).
  // If a legacy admin sends /addjob here, point them at the new bot.
  if (['addjob', 'jobs', 'publish', 'stats', 'grant', 'revoke'].includes(command)) {
    await reply(chatId, 'That command moved to the admin intake bot (a separate Telegram bot). Talk to it there.')
    return jsonOk({ handled: true })
  }

  try {
    switch (command) {
      case 'start': {
        const token = args.split(/\s+/)[0] ?? ''
        if (token) {
          const link = await db.telegramLink.findUnique({ where: { linkTokenHash: sha256(token) } })
          if (!link) {
            await reply(chatId, 'This linking code is invalid or has expired. Generate a fresh one on the Merklane alerts page.')
            break
          }
          const clash = await db.telegramLink.findUnique({ where: { chatId } })
          if (clash && clash.userId !== link.userId) {
            await reply(chatId, 'This Telegram chat is already linked to another Merklane account. /unlink it first.')
            break
          }
          await db.telegramLink.update({
            where: { id: link.id },
            data: { chatId, username: msg.from?.username ?? null, linkedAt: new Date() },
          })
          await db.ingestionLog.create({
            data: { source: 'telegram', action: 'account-linked', actor: link.userId, detail: `chat ${chatId}` },
          })
          await reply(chatId, '✅ Linked. You will now receive premium job alerts here.\nManage them any time: /alerts on|off · /unlink')
        } else {
          await reply(chatId, HELP_TEXT)
        }
        break
      }

      case 'help': {
        await reply(chatId, HELP_TEXT)
        break
      }

      case 'whoami': {
        const link = await db.telegramLink.findUnique({ where: { chatId } })
        if (!link?.chatId) {
          await reply(chatId, 'This chat is not linked. Open the alerts page on Merklane and send me the /start code it shows.')
        } else {
          const user = await db.user.findUnique({ where: { id: link.userId }, select: { email: true, plan: true, premiumUntil: true } })
          // Plan line always shows one of: Premium+ / Premium / Free (with a
          // clear expired hint), so users know exactly where they stand.
          const planLine = user
            ? user.plan === 'premium_plus'
              ? `Plan: ${planDisplayName(user)}`
              : user.plan === 'premium'
                ? `Plan: ${planDisplayName(user)}`
                : 'Plan: Free'
            : 'Plan: unknown'
          const active = user ? isPremiumActive(user) : false
          await reply(
            chatId,
            `Linked account: ${user?.email ?? 'unknown'}\n${planLine}${user?.premiumUntil ? ` (until ${user.premiumUntil.toISOString().slice(0, 10)})` : ''}\nAlerts: ${link.notificationsEnabled ? (active ? 'on' : 'blocked — Premium required') : 'off'}`,
          )
        }
        break
      }

      case 'alerts': {
        const enable = /^on$/i.test(args.trim())
        const disable = /^off$/i.test(args.trim())
        if (!enable && !disable) {
          await reply(chatId, 'Usage: /alerts on · /alerts off')
          break
        }
        const link = await db.telegramLink.findUnique({ where: { chatId } })
        if (!link) {
          await reply(chatId, 'This chat is not linked yet — open the alerts page on Merklane for the /start code.')
          break
        }
        // PAYWALL: only active Premium / Premium+ subscribers may turn job
        // alerts on. Pausing (/alerts off) stays free — a user must always be
        // able to silence us.
        if (enable) {
          const user = await db.user.findUnique({
            where: { id: link.userId },
            select: { plan: true, premiumUntil: true },
          })
          if (!user || !isPremiumActive(user)) {
            await db.ingestionLog.create({
              data: { source: 'telegram', action: 'alerts-on-blocked-no-premium', ok: false, actor: link.userId, detail: `chat ${chatId}` },
            }).catch(() => undefined)
            await reply(
              chatId,
              '🔒 Job alerts are a Premium feature. Upgrade at merklane.com/premium',
            )
            break
          }
        }
        await db.telegramLink.update({ where: { id: link.id }, data: { notificationsEnabled: enable } })
        await reply(chatId, enable ? '🔔 Telegram alerts enabled.' : '🔕 Telegram alerts paused (you still get email if Premium is active).')
        break
      }

      case 'unlink': {
        const link = await db.telegramLink.findUnique({ where: { chatId } })
        if (!link) {
          await reply(chatId, 'Nothing to unlink.')
        } else {
          await db.telegramLink.update({ where: { id: link.id }, data: { chatId: null, username: null, linkedAt: null } })
          await reply(chatId, '✅ Unlinked. Premium alerts will no longer arrive here.')
        }
        break
      }

      default: {
        await reply(chatId, 'Unknown command. /help shows what I can do.')
        await db.ingestionLog.create({
          data: { source: 'telegram', action: `unknown-command:${command}`, ok: false, actor: `tg:${msg.from?.id ?? ''}` },
        })
      }
    }
  } catch (err) {
    console.error('[telegram-webhook] handler error:', err)
    // Still 200 — Telegram must not hammer retries; the user saw an error reply.
    await reply(chatId, '⚠️ Something went wrong processing that command. Check the server logs.').catch(() => undefined)
  }

  return jsonOk({ handled: true })
}

/** GET → wiring status (safe to expose: no secrets, just booleans). */
export async function GET() {
  return jsonOk({
    configured: telegramWebhookConfigured(),
    canSend: Boolean(botEnv.TELEGRAM_BOT_TOKEN),
    adminConfigured: telegramAdminIds().size > 0,
    webhook: 'POST /api/webhooks/telegram',
  })
}

async function reply(chatId: string, html: string) {
  await telegramSendMessage(chatId, html)
}
