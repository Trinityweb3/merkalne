/**
 * One-time (or after a domain change) Telegram webhook registration for
 * BOTH Merklane bots:
 *
 *   bun scripts/set-telegram-webhook.ts            # register whatever is configured
 *   bun scripts/set-telegram-webhook.ts --notifier # only the notifier bot
 *   bun scripts/set-telegram-webhook.ts --admin    # only the admin intake bot
 *
 * Requires in .env (per bot — they are SEPARATE @BotFather bots):
 *
 *   Notifier bot (premium alert DMs + account linking)
 *     TELEGRAM_BOT_TOKEN        — from @BotFather (bot #1)
 *     TELEGRAM_WEBHOOK_SECRET   — random ≥16 chars (openssl rand -hex 24)
 *
 *   Admin intake bot (job composer wizard + admin commands)
 *     TELEGRAM_ADMIN_BOT_TOKEN        — from @BotFather (bot #2)
 *     TELEGRAM_ADMIN_WEBHOOK_SECRET   — a DIFFERENT random ≥16 chars
 *     TELEGRAM_ADMIN_USER_IDS         — your Telegram user id(s), comma-separated
 *
 *   APP_URL — public HTTPS origin of the deployment (https://merklane.com)
 *
 * After this runs, Telegram delivers:
 *   {APP_URL}/api/webhooks/telegram        (notifier: message updates)
 *   {APP_URL}/api/webhooks/telegram-admin  (admin: message + callback_query)
 * each with its own X-Telegram-Bot-Api-Secret-Token header, verified by the
 * routes on every call.
 */
import { botEnv } from '../src/lib/bots/config'

interface BotSpec {
  label: string
  token?: string
  secret?: string
  path: string
  allowedUpdates: string[]
}

async function registerWebhook(spec: BotSpec): Promise<boolean> {
  const { APP_URL } = botEnv
  const url = `${APP_URL}${spec.path}`
  const res = await fetch(`https://api.telegram.org/bot${spec.token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: spec.secret,
      allowed_updates: spec.allowedUpdates,
      drop_pending_updates: true,
    }),
  })

  const payload = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null
  if (res.ok && payload?.ok) {
    console.log(`✅ ${spec.label} webhook registered:`)
    console.log(`   url          : ${url}`)
    console.log(`   secret_token : set (verified by the route on every call)`)
    console.log(`   updates      : ${spec.allowedUpdates.join(', ')}`)
    return true
  }
  console.error(`❌ ${spec.label} setWebhook failed:`, payload?.description ?? `HTTP ${res.status}`)
  return false
}

async function main() {
  const flag = process.argv[2] ?? ''
  const wantNotifier = flag !== '--admin'
  const wantAdmin = flag !== '--notifier'

  let failures = 0

  if (wantNotifier) {
    if (botEnv.TELEGRAM_BOT_TOKEN && botEnv.TELEGRAM_WEBHOOK_SECRET) {
      if (!(await registerWebhook({
        label: 'Notifier bot (alerts + linking)',
        token: botEnv.TELEGRAM_BOT_TOKEN,
        secret: botEnv.TELEGRAM_WEBHOOK_SECRET,
        path: '/api/webhooks/telegram',
        allowedUpdates: ['message'],
      }))) failures += 1
    } else {
      console.log('ℹ️  Notifier bot not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET) — skipped.')
      if (flag === '') console.log('   (Pass --notifier/--admin to select one bot; run with no flags once both are set.)')
    }
  }

  if (wantAdmin) {
    if (botEnv.TELEGRAM_ADMIN_BOT_TOKEN && botEnv.TELEGRAM_ADMIN_WEBHOOK_SECRET) {
      if (!(await registerWebhook({
        label: 'Admin intake bot (job wizard)',
        token: botEnv.TELEGRAM_ADMIN_BOT_TOKEN,
        secret: botEnv.TELEGRAM_ADMIN_WEBHOOK_SECRET,
        path: '/api/webhooks/telegram-admin',
        allowedUpdates: ['message', 'callback_query'],
      }))) failures += 1
      if (!botEnv.TELEGRAM_ADMIN_USER_IDS) {
        console.warn('⚠️  TELEGRAM_ADMIN_USER_IDS is empty — the admin bot will reject every update.')
      }
    } else {
      console.log('ℹ️  Admin intake bot not configured (TELEGRAM_ADMIN_BOT_TOKEN / TELEGRAM_ADMIN_WEBHOOK_SECRET) — skipped.')
    }
  }

  if (!botEnv.APP_URL.startsWith('https://')) {
    console.warn(`⚠️  APP_URL is ${botEnv.APP_URL} — Telegram only delivers webhooks to public HTTPS URLs.`)
  }

  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
