/**
 * One-time (or after domain change) Telegram webhook registration.
 *
 *   bun scripts/set-telegram-webhook.ts
 *
 * Requires in .env:
 *   TELEGRAM_BOT_TOKEN       — from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET  — random ≥16 chars (openssl rand -hex 24)
 *   APP_URL                  — public HTTPS origin of the deployment
 *
 * After this runs, Telegram delivers every bot update to
 * {APP_URL}/api/webhooks/telegram with the X-Telegram-Bot-Api-Secret-Token
 * header, which the route verifies on every call.
 */
import { botEnv } from '../src/lib/bots/config'

async function main() {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL } = botEnv

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET) {
    console.error(
      'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET in the environment.\n' +
        'Set them in .env (see .env.example) and try again.',
    )
    process.exit(1)
  }
  if (!APP_URL.startsWith('https://')) {
    console.warn(`⚠️  APP_URL is ${APP_URL} — Telegram only delivers webhooks to public HTTPS URLs.`)
  }

  const url = `${APP_URL}/api/webhooks/telegram`
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    }),
  })

  const payload = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null
  if (res.ok && payload?.ok) {
    console.log(`✅ Telegram webhook registered:`)
    console.log(`   url          : ${url}`)
    console.log(`   secret_token : set (verified by the route on every call)`)
    console.log(`   updates      : message only`)
  } else {
    console.error('❌ setWebhook failed:', payload?.description ?? `HTTP ${res.status}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
