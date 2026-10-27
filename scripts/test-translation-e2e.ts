/// <reference types="bun-types" />
/**
 * Translation pipeline E2E — proves the full DB-cache → LibreTranslate →
 * persist → serve cycle with an in-process mock of the LibreTranslate API.
 *
 * The mock (Bun.serve on :5001) counts /translate calls so the test can prove
 * the DB cache actually prevents repeat translation work.
 */
import { PrismaClient } from '@prisma/client'

const ORIGIN = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const MOCK_PORT = 5001
const db = new PrismaClient()
let failures = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) console.log(`  [ok]   ${label}`)
  else {
    failures += 1
    console.log(`  [FAIL] ${label} ${extra}`)
  }
}

// --- mock LibreTranslate -----------------------------------------------------
let translateCalls = 0
let languagesCalls = 0
/** Last /translate request body — proves glossary placeholders were sent. */
let lastTranslateQ: string[] | string | null = null
const ALL = ['ru', 'es', 'pt', 'fr', 'de', 'tr', 'zh', 'ar', 'hi', 'id', 'vi', 'ko', 'ja', 'it', 'pl', 'sv', 'uk', 'tl']

const mock = Bun.serve({
  port: MOCK_PORT,
  fetch: async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/languages') {
      languagesCalls += 1
      return Response.json([{ code: 'en', targets: ALL }])
    }
    if (url.pathname === '/translate' && req.method === 'POST') {
      translateCalls += 1
      const body = (await req.json()) as { q: string[] | string; target: string }
      const q = Array.isArray(body.q) ? body.q : [body.q]
      lastTranslateQ = body.q
      // Marker translation: deterministic, obviously different from source.
      const out = q.map((s) => `[${body.target.toUpperCase()}] ${s}`)
      return Response.json({ translatedText: q.length === 1 ? out[0] : out })
    }
    return new Response('not found', { status: 404 })
  },
})

async function main() {
  const SLUG = 'translation-e2e-test-post'
  const TITLE = 'Translation Pipeline Test Post'
  const BODY = 'This body exists to prove the full-granularity translation path works end to end.'

  // Clean slate
  await db.post.deleteMany({ where: { OR: [{ slug: SLUG }, { title: TITLE }] } })

  const post = await db.post.create({
    data: {
      title: TITLE,
      slug: SLUG,
      section: 'markets',
      status: 'published',
      body: BODY,
      author: { connectOrCreate: { where: { email: 'translate-e2e@test.local' }, create: { email: 'translate-e2e@test.local', passwordHash: 'x', name: 'E2E' } } },
    },
  })
  console.log(`— test post created (${post.id.slice(-6)}, translations=${JSON.stringify(post.translations)}) —`)

  console.log('— 1. list request in ru (cache MISS → mock translate → persist) —')
  const r1 = await fetch(`${ORIGIN}/api/posts?section=markets&locale=ru&limit=50`)
  const b1 = (await r1.json()) as { data?: { posts?: Array<{ title: string; slug: string }> } }
  const mine1 = b1.data?.posts?.find((p) => p.slug === SLUG)
  ok('ru list shows translated title', mine1?.title === `[RU] ${TITLE}`, JSON.stringify(mine1?.title))
  ok('mock received exactly one /translate call (batched)', translateCalls === 1, `calls=${translateCalls}`)

  const stored = await db.post.findUnique({ where: { id: post.id }, select: { translations: true } })
  const ruTitle = (stored?.translations as Record<string, { title?: string }> | null)?.ru?.title
  ok('translation persisted to Post.translations.ru.title', ruTitle === `[RU] ${TITLE}`, JSON.stringify(stored?.translations))

  console.log('— 2. second list request (cache HIT — no new translate calls) —')
  const r2 = await fetch(`${ORIGIN}/api/posts?section=markets&locale=ru&limit=50`)
  const b2 = (await r2.json()) as { data?: { posts?: Array<{ title: string; slug: string }> } }
  const mine2 = b2.data?.posts?.find((p) => p.slug === SLUG)
  ok('ru list still shows translated title', mine2?.title === `[RU] ${TITLE}`)
  ok('mock /translate calls unchanged (DB cache hit)', translateCalls === 1, `calls=${translateCalls}`)

  console.log('— 3. article page in ru (title cached, body translated once) —')
  const page1 = await fetch(`${ORIGIN}/ru/markets/${SLUG}`)
  ok('/ru/markets/<slug> renders 200', page1.status === 200, `got ${page1.status}`)
  const html1 = await page1.text()
  ok('article shows translated title', html1.includes('[RU] Translation Pipeline Test Post'), 'translated title not in HTML')
  ok('article shows translated body', html1.includes('[RU] This body exists'), 'translated body not in HTML')

  const storedFull = await db.post.findUnique({ where: { id: post.id }, select: { translations: true } })
  const ruFull = (storedFull?.translations as Record<string, { title?: string; body?: string }> | null)?.ru
  ok('body persisted to Post.translations.ru.body', ruFull?.body === `[RU] ${BODY}`, JSON.stringify(ruFull))
  const callsAfterArticle = translateCalls
  ok('article caused exactly one more /translate call (body only)', callsAfterArticle === 2, `calls=${translateCalls}`)

  console.log('— 4. article again (everything cached) —')
  await fetch(`${ORIGIN}/ru/markets/${SLUG}`)
  ok('no additional /translate calls on re-visit', translateCalls === 2, `calls=${translateCalls}`)

  console.log('— 5. a different locale (es) is translated independently —')
  const r5 = await fetch(`${ORIGIN}/api/posts?section=markets&locale=es&limit=50`)
  const b5 = (await r5.json()) as { data?: { posts?: Array<{ title: string; slug: string }> } }
  const mine5 = b5.data?.posts?.find((p) => p.slug === SLUG)
  ok('es list shows translated title', mine5?.title === `[ES] ${TITLE}`, JSON.stringify(mine5?.title))

  console.log('— 6. English untouched —')
  const r6 = await fetch(`${ORIGIN}/api/posts?section=markets&limit=50`)
  const b6 = (await r6.json()) as { data?: { posts?: Array<{ title: string; slug: string }> } }
  const mine6 = b6.data?.posts?.find((p) => p.slug === SLUG)
  ok('en list keeps the original title', mine6?.title === TITLE, JSON.stringify(mine6?.title))

  console.log('— 7. custom glossary: Web3 jargon survives translation intact —')
  const SLUG2 = 'glossary-e2e-test-post'
  const TITLE2 = 'DeFi TVL hits record on-chain'
  await db.post.deleteMany({ where: { slug: SLUG2 } })
  const post2 = await db.post.create({
    data: {
      title: TITLE2,
      slug: SLUG2,
      section: 'markets',
      status: 'published',
      body: 'Yield farming on a Layer 2 DEX with deep liquidity.',
      author: { connectOrCreate: { where: { email: 'translate-e2e@test.local' }, create: { email: 'translate-e2e@test.local', passwordHash: 'x', name: 'E2E' } } },
    },
  })
  const r7 = await fetch(`${ORIGIN}/api/posts?section=markets&locale=ru&limit=50`)
  const b7 = (await r7.json()) as { data?: { posts?: Array<{ title: string; slug: string }> } }
  const mine7 = b7.data?.posts?.find((p) => p.slug === SLUG2)
  ok(
    'glossary terms restored after translation (exact match)',
    mine7?.title === `[RU] ${TITLE2}`,
    JSON.stringify(mine7?.title),
  )
  const sentQ = Array.isArray(lastTranslateQ) ? lastTranslateQ : [String(lastTranslateQ ?? '')]
  const protectedTitle = sentQ.find((s) => s.includes('hits record'))
  ok(
    'mock received ⟦N⟧ placeholders, not the raw jargon (protection proof)',
    Boolean(protectedTitle && /⟦\d+⟧/.test(protectedTitle) && !protectedTitle.includes('DeFi')),
    JSON.stringify(protectedTitle),
  )
  ok('no placeholder leaked into the served title', !mine7?.title.includes('⟦'), JSON.stringify(mine7?.title))
  const stored2 = await db.post.findUnique({ where: { id: post2.id }, select: { translations: true } })
  const ru2 = (stored2?.translations as Record<string, { title?: string }> | null)?.ru?.title
  ok('glossary-corrected title persisted to Post.translations.ru.title', ru2 === `[RU] ${TITLE2}`, JSON.stringify(ru2))

  console.log('— 8. glossary: per-language replacement from the custom file —')
  // "Yield farming" is mapped to "Фарминг доходности" for ru in
  // config/translation-glossary.json — the ru article body must use it.
  const page8 = await fetch(`${ORIGIN}/ru/markets/${SLUG2}`)
  const html8 = await page8.text()
  ok(
    'ru body uses the ru replacement for Yield farming',
    html8.includes('[RU] Фарминг доходности'),
    'replacement not found in HTML',
  )
  ok('ru body protects Layer 2 and DEX too', html8.includes('Layer 2') && html8.includes('DEX'), 'built-in terms not restored')
  await db.post.deleteMany({ where: { id: post2.id } })

  console.log(`\nlanguages calls: ${languagesCalls}, translate calls: ${translateCalls}`)
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)

  // cleanup
  await db.post.deleteMany({ where: { id: post.id } })
  await db.user.deleteMany({ where: { email: 'translate-e2e@test.local' } })
  mock.stop(true)
  await db.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  mock.stop(true)
  await db.$disconnect()
  process.exit(1)
})
