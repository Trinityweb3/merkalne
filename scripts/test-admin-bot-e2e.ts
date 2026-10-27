/// <reference types="bun-types" />
/**
 * E2E test of the ADMIN INTAKE BOT webhook (/api/webhooks/telegram-admin)
 * against the running dev server — bulk-paste composer + security gates.
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

  console.log('— bulk paste: ➕ Add job → paste labeled text → parsed → ✅ Publish —')
  await post(cbq('new'))
  ok('state step = paste after ➕ Add job', (await stateOf())?.step === 'paste', JSON.stringify(await stateOf()))

  // A paste with mixed labeled + unlabeled lines, exactly like a forwarded post.
  const labeledPaste = [
    'Company: Acme Corp',
    'Title: Senior Wizard Test Engineer',
    'URL: https://acme.example/apply',
    'Salary: $80k–$120k',
    'Type: Full-time',
    'Workplace: Remote',
    'Description: Build the parsing pipeline for the admin bot and ship it.',
  ].join('\n')
  const pasted = await post(msg(labeledPaste))
  ok('paste accepted (handled)', pasted.body?.data?.handled === true, JSON.stringify(pasted.body))

  const st = await stateOf()
  ok('state step = confirm after paste', st?.step === 'confirm', JSON.stringify(st?.step))
  const spec = (st?.draft?.spec ?? {}) as Record<string, unknown>
  ok('parsed title from "Title:" label', spec.title === 'Senior Wizard Test Engineer', JSON.stringify(spec.title))
  ok('parsed company from "Company:" label', spec.company === 'Acme Corp', JSON.stringify(spec.company))
  ok('parsed applyUrl from "URL:" label', spec.applyUrl === 'https://acme.example/apply', JSON.stringify(spec.applyUrl))
  ok('parsed salary from "Salary:" label', spec.salary === '$80k–$120k', JSON.stringify(spec.salary))
  ok('parsed employment from "Type:" label', spec.employment === 'Full-time', JSON.stringify(spec.employment))
  ok('parsed workplace from "Workplace:" label', spec.workplace === 'Remote', JSON.stringify(spec.workplace))
  ok('parsed body from "Description:" label', typeof spec.body === 'string' && spec.body.includes('parsing pipeline'), JSON.stringify(spec.body))
  ok('section inferred mid-senior (senior + job labels)', spec.section === 'mid-senior', JSON.stringify(spec.section))
  ok('level guessed Senior', spec.level === 'Senior', JSON.stringify(spec.level))

  const before = await db.post.count({ where: { title: 'Senior Wizard Test Engineer' } })
  await post(cbq('pub'))
  const created = await db.post.findFirst({ where: { title: 'Senior Wizard Test Engineer' }, orderBy: { createdAt: 'desc' } })
  ok('✅ Publish created the post (published)', (await db.post.count({ where: { title: 'Senior Wizard Test Engineer' } })) === before + 1 && created?.status === 'published', `status=${created?.status}`)
  ok('state cleared after publish', (await stateOf()) === null)
  ok('post carries parsed fields', created?.section === 'mid-senior' && created?.workplace === 'Remote' && created?.employment === 'Full-time' && created?.applyUrl === 'https://acme.example/apply', JSON.stringify({ section: created?.section, workplace: created?.workplace, employment: created?.employment }))
  ok('body captured from the paste', Boolean(created?.body && created.body.includes('parsing pipeline')), `len=${created?.body?.length}`)

  console.log('— bulk paste: unlabeled paste → section re-pick via 🔄 —')
  await post(cbq('new'))
  const plainPaste = [
    'Junior Rust Dev at Parity',
    'https://parity.example/jobs',
    'Remote (EU)',
    'Write CLI tools in Rust for the polkadot ecosystem.',
  ].join('\n')
  await post(msg(plainPaste))
  const st2 = await stateOf()
  const spec2 = (st2?.draft?.spec ?? {}) as Record<string, unknown>
  ok('unlabeled title from first line', spec2.title === 'Junior Rust Dev', JSON.stringify(spec2.title))
  ok('"at" split extracted the company', spec2.company === 'Parity', JSON.stringify(spec2.company))
  ok('first URL became applyUrl', spec2.applyUrl === 'https://parity.example/jobs', JSON.stringify(spec2.applyUrl))
  ok('Remote (EU) → workplace Remote + location EU', spec2.workplace === 'Remote' && spec2.location === 'EU', JSON.stringify({ workplace: spec2.workplace, location: spec2.location }))
  ok('junior keyword → section intern-junior', spec2.section === 'intern-junior', JSON.stringify(spec2.section))
  ok('level guessed Junior', spec2.level === 'Junior', JSON.stringify(spec2.level))

  await post(cbq('sec:mid-senior'))
  const st3 = await stateOf()
  const spec3 = (st3?.draft?.spec ?? {}) as Record<string, unknown>
  ok('🔄 section change applied (mid-senior)', st3?.step === 'confirm' && spec3.section === 'mid-senior', JSON.stringify(spec3.section))

  await post(msg('/cancel'))
  ok('cancel clears the draft', (await stateOf()) === null)

  console.log('— power commands —')
  // NOTE: a DIFFERENT apply URL than the paste above — intake dedupes on
  // (source, applyUrl), so reusing it would skip creation as a duplicate.
  const add = await post(msg('/addjob Power Command Post | Acme Corp | https://acme.example/careers/power | intern-junior | rust,cli'))
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
  // cleanup
  await db.post.deleteMany({ where: { title: { in: ['Senior Wizard Test Engineer', 'Power Command Post'] } } })
  await db.user.deleteMany({ where: { email: 'admin-bot-e2e@test.local' } })
  await db.telegramAdminState.deleteMany({})
  await db.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await db.telegramAdminState.deleteMany({})
  await db.$disconnect()
  process.exit(1)
})
