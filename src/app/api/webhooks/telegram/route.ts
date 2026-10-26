import { db } from '@/lib/db'
import { jsonError, jsonOk } from '@/lib/api'
import { rateLimit } from '@/lib/rate-limit'
import { sha256 } from '@/lib/csrf'
import { botEnv, telegramAdminIds, telegramWebhookConfigured } from '@/lib/bots/config'
import { parseTelegramCommand, telegramSendMessage, type TelegramUpdate } from '@/lib/bots/telegram'
import {
  createJobFromSpec,
  grantPremium,
  intakeStats,
  listRecentJobs,
  parseAddJobArgs,
  publishPostById,
  revokePremium,
} from '@/lib/bots/intake'

/**
 * POST /api/webhooks/telegram — Telegram Bot API webhook.
 *
 * This is the admin-facing Job Ingestion Bot:
 *   /addjob  Title | Company | URL | Section | tags [key=value…]
 *   /jobs    [n]            — recent drafts + published postings
 *   /publish <id>           — publish a draft (fires premium dispatch)
 *   /stats                  — pipeline counters
 *   /grant <email> <days>   — activate premium for a user
 *   /revoke <email>         — deactivate premium
 *   /start <token>          — link a web account for premium DMs
 *   /alerts on|off · /unlink · /whoami · /help
 *
 * Security model (server-to-server — CSRF is not applicable):
 *   • every request must carry the X-Telegram-Bot-Api-Secret-Token header set
 *     via setWebhook (compared against TELEGRAM_WEBHOOK_SECRET)
 *   • write commands are restricted to TELEGRAM_ADMIN_USER_IDS
 *   • per-chat sliding-window rate limit; all inputs Zod-validated in intake.ts
 *   • every admin action is written to IngestionLog
 *
 * Always answers 200 to Telegram (error text is sent as the bot reply) so the
 * Bot API does not retry user mistakes.
 */

const HELP_TEXT = [
  '<b>Merklane admin bot</b>',
  '',
  '<b>Job intake</b>',
  '/addjob Title | Company | Apply URL | Section | tags,comma',
  '  extras on following lines: kind= location= workplace= employment=',
  '  level= salary= stack= body= publish=yes',
  '/jobs [n] — recent postings · /publish &lt;id&gt; — publish a draft',
  '',
  '<b>Premium</b>',
  '/grant email 30 — add 30 premium days · /revoke email',
  '',
  '<b>Your alerts</b>',
  '/start — link your account · /alerts on|off · /unlink · /whoami',
  '',
  'Sections: intern-junior, mid-senior, opportunities, markets, insights, blog',
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
    return jsonOk({ ignored: true }) // channel posts, edits, etc.
  }

  const msg = update.message
  const chatId = String(msg.chat.id)
  const fromId = String(msg.from?.id ?? '')

  const rl = rateLimit(`tg-webhook:${chatId}`, 20, 60_000)
  if (!rl.ok) return jsonOk({ ignored: true, reason: 'rate_limited' })

  const parsedCommand = parseTelegramCommand(msg.text)
  if (!parsedCommand) {
    await reply(chatId, 'Commands start with <b>/</b>. Send /help for the manual.')
    return jsonOk({ handled: true })
  }
  const { command, args } = parsedCommand
  const isAdmin = telegramAdminIds().has(fromId)

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
          await reply(
            chatId,
            `Linked account: ${user?.email ?? 'unknown'}\nPlan: ${user?.plan ?? 'unknown'}${user?.premiumUntil ? ` (until ${user.premiumUntil.toISOString().slice(0, 10)})` : ''}\nAlerts: ${link.notificationsEnabled ? 'on' : 'off'}`,
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

      // ---- admin commands --------------------------------------------------
      case 'addjob': {
        if (!requireAdmin(chatId, isAdmin)) break
        const parsed = parseAddJobArgs(args)
        if (!parsed.ok) {
          await reply(chatId, `⚠️ ${parsed.message}`)
          break
        }
        const result = await createJobFromSpec(parsed.spec, { source: 'telegram', actor: `tg:${fromId}` })
        if (!result.ok) {
          await reply(chatId, `⚠️ ${result.message}`)
          break
        }
        await reply(
          chatId,
          result.post.deduped
            ? `♻️ Already in the database:\n${result.post.title}\nid: ${result.post.id} (${result.post.status})`
            : `✅ ${result.post.status === 'published' ? 'Published' : 'Draft created'}:\n${result.post.title}\n` +
                `id: ${result.post.id} · section: ${result.post.section}` +
                (result.post.status === 'draft' ? `\nPublish with: /publish ${result.post.id}` : '\nPremium alerts are being dispatched.'),
        )
        break
      }

      case 'jobs': {
        if (!requireAdmin(chatId, isAdmin)) break
        const limit = Number(args.split(/\s+/)[0] ?? 5)
        const jobs = await listRecentJobs(Number.isFinite(limit) ? limit : 5)
        if (jobs.length === 0) {
          await reply(chatId, 'No postings yet. Add the first with /addjob.')
        } else {
          await reply(
            chatId,
            jobs
              .map((j) => `[${j.status === 'draft' ? '📝' : '🟢'}] ${j.id.slice(-6)} · ${j.title} — ${j.company ?? '?'} (${j.section})`)
              .join('\n'),
          )
        }
        break
      }

      case 'publish': {
        if (!requireAdmin(chatId, isAdmin)) break
        const id = args.trim()
        if (!id) {
          await reply(chatId, 'Usage: /publish <job id> (see /jobs)')
          break
        }
        const res = await publishPostById(id)
        await reply(chatId, res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`)
        break
      }

      case 'stats': {
        if (!requireAdmin(chatId, isAdmin)) break
        const s = await intakeStats()
        await reply(
          chatId,
          [
            '<b>Pipeline</b>',
            `Published: ${s.published} · Drafts: ${s.drafts}`,
            `Waitlist: ${s.waitlist}`,
            `Active premium: ${s.premium}`,
            `Alerts pending: ${s.pendingAlerts} · failed: ${s.failedAlerts}`,
          ].join('\n'),
        )
        break
      }

      case 'grant': {
        if (!requireAdmin(chatId, isAdmin)) break
        const [email, daysRaw] = args.split(/\s+/)
        const days = Number(daysRaw)
        if (!email || !Number.isFinite(days) || days < 1 || days > 3650) {
          await reply(chatId, 'Usage: /grant user@email.com 30')
          break
        }
        const res = await grantPremium(email, Math.floor(days))
        await reply(chatId, res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`)
        break
      }

      case 'revoke': {
        if (!requireAdmin(chatId, isAdmin)) break
        const email = args.trim()
        if (!email) {
          await reply(chatId, 'Usage: /revoke user@email.com')
          break
        }
        const res = await revokePremium(email)
        await reply(chatId, res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`)
        break
      }

      default: {
        await reply(chatId, 'Unknown command. /help shows the manual.')
        await db.ingestionLog.create({
          data: { source: 'telegram', action: `unknown-command:${command}`, ok: false, actor: `tg:${fromId}` },
        })
      }
    }
  } catch (err) {
    console.error('[telegram-webhook] handler error:', err)
    // Still 200 — Telegram must not hammer retries; the admin saw an error reply.
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

function requireAdmin(chatId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true
  void reply(chatId, '⛔ Admin commands require your Telegram id to be listed in TELEGRAM_ADMIN_USER_IDS.').catch(() => undefined)
  void db.ingestionLog
    .create({ data: { source: 'telegram', action: 'admin-command-denied', ok: false, actor: chatId } })
    .catch(() => undefined)
  return false
}
