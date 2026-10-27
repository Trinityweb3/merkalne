/**
 * Post-E2E cleanup + regression checks for the split notifier route and the
 * translation fallback (no LibreTranslate → localized pages serve English).
 */
import { PrismaClient } from '@prisma/client'

const ORIGIN = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const db = new PrismaClient()
let failures = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) console.log(`  [ok]   ${label}`)
  else {
    failures += 1
    console.log(`  [FAIL] ${label} ${extra}`)
  }
}

async function main() {
  console.log('— cleanup test data —')
  const del1 = await db.post.deleteMany({ where: { title: { in: ['Senior Wizard Test Engineer', 'Power Command Post'] } } })
  await db.telegramAdminState.deleteMany({})
  await db.ingestionLog.deleteMany({ where: { actor: { startsWith: 'tg-admin:' } } })
  await db.ingestionLog.deleteMany({ where: { actor: 'tg:777777' } })
  console.log(`  removed ${del1.count} test posts, admin states, ingestion logs`)

  console.log('— notifier route (post-split regression) —')
  const status = await fetch(`${ORIGIN}/api/webhooks/telegram`)
  const sBody = (await status.json()) as { data?: Record<string, unknown> }
  ok('GET status: 200 + honest wiring booleans', status.status === 200 && sBody.data?.webhook === 'POST /api/webhooks/telegram', JSON.stringify(sBody))
  ok('notifier secret NOT configured (separate from admin secret)', sBody.data?.configured === false)

  const noSecret = await fetch(`${ORIGIN}/api/webhooks/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 1 }, chat: { id: 1, type: 'private' }, date: 1, text: '/start' } }),
  })
  ok('notifier POST without secret → 503 (not configured, honest)', noSecret.status === 503, `got ${noSecret.status}`)

  console.log('— translation fallback (no LibreTranslate configured) —')
  const ru = await fetch(`${ORIGIN}/ru/markets`)
  ok('/ru/markets still renders (200)', ru.status === 200, `got ${ru.status}`)
  const html = await ru.text()
  ok('Russian UI chrome present on the page', html.includes('Возможности') || html.includes('Рынки') || html.includes('Маркет'), 'no Russian chrome found')
  const api = await fetch(`${ORIGIN}/api/posts?locale=ru&limit=3`)
  ok('GET /api/posts?locale=ru → 200 (graceful without LibreTranslate)', api.status === 200, `got ${api.status}`)

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
  await db.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await db.$disconnect()
  process.exit(1)
})
