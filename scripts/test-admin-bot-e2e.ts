/**
 * E2E test of the ADMIN INTAKE BOT webhook (/api/webhooks/telegram-admin)
 * against the running dev server — full wizard state machine + security gates.
 *
 * No real bot token is configured: replies go through the console fallback,
 * which lets us assert the full flow locally. DB state is asserted via Prisma.
 */
import { PrismaClient } from '@prisma/client'

const ORIGIN = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const BASE = `${ORIGIN}/api/webhooks/telegram-admin`
const SECRET = 'test_admin_secret_0123456789ab'
const ADMIN = 999000111
const db = new PrismaClient()

let uid = 1000
let failures = 0

function ok(label: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [ok]   ${label}`)
  else {
    failures += 1
    console.log(`  [FAIL] ${label} ${extra}`)
  }
}

function msg(text: string, fromId = ADMIN) {
  return {
    update_id: uid++,
    message: {
      message_id: uid,
      from: { id: fromId, first_name: 'Admin' },
      chat: { id: fromId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  }
}

function cbq(data: string, fromId = ADMIN) {
  return {
    update_id: uid++,
    callback_query: {
      id: `cq${uid}`,
      from: { id: fromId },
      message: { message_id: 1, chat: { id: fromId, type: 'private' }, date: Math.floor(Date.now() / 1000) },
      data,
    },
  }
}

/** Shape the telegram-admin webhook responds with (console-fallback mode). */
interface BotApiResponse {
  ok?: boolean
  data?: { denied?: boolean; handled?: boolean; [key: string]: unknown }
  [key: string]: unknown
}

async function post(update: unknown, secret = SECRET): Promise<{ status: number; body: BotApiResponse | null }> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as BotApiResponse | null }
}

async function stateOf(id = String(ADMIN)) {
  const row = await db.telegramAdminState.findUnique({ where: { adminUserId: id } })
  return row ? { step: row.step, draft: row.draft as Record<string, unknown> } : null
}

async function main() {
  console.log('— security gates —')
  const wrong = await post(msg('/start'), 'WRONG_SECRET')
  ok('wrong webhook secret → 403', wrong.status === 403, `got ${wrong.status}`)

  const stranger = await post(msg('/start', 777777))
  ok('non-admin update → 200 + denied', stranger.status === 200 && stranger.body?.data?.denied === true, JSON.stringify(stranger.body))

  const badJson = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: 'not json',
  })
  ok('invalid JSON → 400', badJson.status === 400, `got ${badJson.status}`)

  console.log('— wizard: /start → menu → new → section → … —')
  await post(msg('/start'))
  await post(cbq('new'))
  ok('after ➕ Add job → step=section', (await stateOf())?.step === 'section')

  await post(cbq('sec:blog'))
  let st = await stateOf()
  ok('after sec:blog → step=title, draft.section=blog', st?.step === 'title' && st?.draft?.section === 'blog', JSON.stringify(st))

  const badTitle = await post(msg('No'))
  ok('title validation rejects <4 chars (stays on title)', (await stateOf())?.step === 'title', JSON.stringify(badTitle.body?.data))

  await post(msg('Senior Wizard Test Engineer'))
  ok('title accepted → step=company', (await stateOf())?.step === 'company')

  await post(msg('Merklane Test Lab'))
  ok('company accepted → step=location', (await stateOf())?.step === 'location')

  await post(cbq('skip')) // location → workplace
  ok('skip location → step=workplace', (await stateOf())?.step === 'workplace')

  await post(cbq('wp:Remote'))
  ok('wp:Remote → step=employment + draft.workplace=Remote', (await stateOf())?.step === 'employment' && (await stateOf())?.draft?.workplace === 'Remote')

  await post(cbq('emp:Full-time'))
  ok('emp:Full-time → step=level', (await stateOf())?.step === 'level')

  await post(cbq('lvl:Senior'))
  st = await stateOf()
  ok('lvl:Senior → step=salary + draft.level=Senior', st?.step === 'salary' && st?.draft?.level === 'Senior', JSON.stringify(st))

  await post(msg('$90k–$140k'))
  ok('salary accepted → step=stack', (await stateOf())?.step === 'stack')

  await post(cbq('skip')) // stack → applyUrl
  await post(cbq('skip')) // applyUrl → body
  await post(cbq('skip')) // body → tags
  ok('three skips → step=tags', (await stateOf())?.step === 'tags')

  await post(msg('wizard,test,e2e'))
  st = await stateOf()
  ok('tags accepted → step=confirm + 3 tags', st?.step === 'confirm' && (st?.draft?.tags as string[] | undefined)?.length === 3, JSON.stringify(st))

  console.log('— publish —')
  const before = await db.post.count({ where: { title: 'Senior Wizard Test Engineer' } })
  await post(cbq('pub'))
  const created = await db.post.findFirst({ where: { title: 'Senior Wizard Test Engineer' }, orderBy: { createdAt: 'desc' } })
  ok('✅ Publish created the post (published)', (await db.post.count({ where: { title: 'Senior Wizard Test Engineer' } })) === before + 1 && created?.status === 'published', `status=${created?.status}`)
  ok('wizard state cleared after publish', (await stateOf()) === null)
  ok('post carries wizard fields', created?.section === 'blog' && created?.workplace === 'Remote' && created?.employment === 'Full-time' && created?.level === 'Senior' && created?.location === null, JSON.stringify({ section: created?.section, workplace: created?.workplace, employment: created?.employment, level: created?.level }))
  ok('body auto-generated when skipped', Boolean(created?.body && created.body.length > 50), `len=${created?.body?.length}`)

  console.log('— power commands —')
  const add = await post(msg('/addjob Power Command Post | Acme Corp | https://acme.example/apply | intern-junior | rust,cli'))
  ok('/addjob one-liner → handled', add.body?.data?.handled === true, JSON.stringify(add.body))
  const power = await db.post.findFirst({ where: { title: 'Power Command Post' }, orderBy: { createdAt: 'desc' } })
  ok('/addjob created draft in intern-junior', power?.section === 'intern-junior' && power?.status === 'draft', `section=${power?.section} status=${power?.status}`)

  const jobs = await post(msg('/jobs 3'))
  ok('/jobs lists postings', jobs.body?.data?.handled === true)

  const stats = await post(msg('/stats'))
  ok('/stats works', stats.body?.data?.handled === true)

  const grantBad = await post(msg('/grant notanemail'))
  ok('/grant usage hint on bad input', grantBad.body?.data?.handled === true)

  await post(msg('/cancel'))

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
  await db.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await db.$disconnect()
  process.exit(1)
})
