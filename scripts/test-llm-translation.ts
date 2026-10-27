/// <reference types="bun-types" />
/**
 * LLM translation-provider chain E2E (in-process).
 *
 * Exercises src/lib/translate.ts against a mocked global fetch — no real
 * network, no dev server, no database. Each scenario runs in its OWN child
 * process (env.ts parses process.env once at import, so per-scenario env
 * needs per-scenario processes); the parent spawns them sequentially and
 * aggregates the results.
 *
 * Covered: provider priority (Groq → DeepSeek → Gemini → LibreTranslate),
 * Groq request shape (URL/auth/model/system prompt/JSON mode), glossary
 * placeholder protection through the LLM lane, HASHTAG protection (#tokens
 * survive every lane byte-identically and are never split by glossary
 * terms), de-duplication + blank filtering, 429 → cooldown →
 * LibreTranslate fallback, model-not-found fallback (gpt-oss-120b →
 * qwen3.8-27b, remembered), mangled-placeholder fail-safe, and the
 * About-page indicator info.
 *
 * Run:  bun scripts/test-llm-translation.ts
 */
let failures = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) console.log(`  [ok]   ${label}`)
  else {
    failures += 1
    console.log(`  [FAIL] ${label} ${extra}`)
  }
}

// ---------------------------------------------------------------------------
// Parent mode: spawn one child per scenario, aggregate exit codes.
// ---------------------------------------------------------------------------
const ALL_SCENARIOS = [
  'groq',
  'groq-rate-limit',
  'groq-model-fallback',
  'groq-mangled-placeholder',
  'hashtag-protection',
  'deepseek',
  'gemini',
  'libretranslate-only',
] as const

if (!process.env.SCENARIO) {
  console.log('LLM translation provider chain — in-process E2E\n')
  const results: Array<{ name: string; ok: boolean }> = []
  for (const name of ALL_SCENARIOS) {
    console.log(`— scenario: ${name} —`)
    const proc = Bun.spawnSync(['bun', import.meta.path], {
      env: { ...process.env, SCENARIO: name },
      stdout: 'inherit',
      stderr: 'inherit',
      cwd: import.meta.dir + '/..',
    })
    const good = proc.exitCode === 0
    results.push({ name, ok: good })
    if (!good) console.log(`  [FAIL] scenario "${name}" exited with ${proc.exitCode}`)
  }
  console.log('\n' + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`).join('\n'))
  const failed = results.filter((r) => !r.ok).length
  console.log(failed === 0 ? 'ALL PASS' : `${failed} SCENARIO FAILURES`)
  process.exit(failed === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Child mode (SCENARIO set): per-scenario env, fetch mock, assertions.
// ---------------------------------------------------------------------------

/** Every provider var is set explicitly so a developer's .env cannot leak in. */
const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'file:/tmp/merklane-llm-test.db', // schema-only requirement; never opened
  GROQ_API_KEY: '',
  DEEPSEEK_API_KEY: '',
  GOOGLE_AI_API_KEY: '',
  LIBRETRANSLATE_URL: '',
  LIBRETRANSLATE_API_KEY: '',
}

const SCENARIO_ENV: Record<string, Record<string, string>> = {
  groq: { GROQ_API_KEY: 'test-groq-key' },
  'groq-rate-limit': { GROQ_API_KEY: 'test-groq-key', LIBRETRANSLATE_URL: 'http://lt.mock' },
  'groq-model-fallback': { GROQ_API_KEY: 'test-groq-key' },
  'groq-mangled-placeholder': { GROQ_API_KEY: 'test-groq-key' },
  'hashtag-protection': { GROQ_API_KEY: 'test-groq-key' },
  deepseek: { DEEPSEEK_API_KEY: 'test-deepseek-key' },
  gemini: { GOOGLE_AI_API_KEY: 'test-gemini-key' },
  'libretranslate-only': { LIBRETRANSLATE_URL: 'http://lt.mock' },
}

const SCENARIO = process.env.SCENARIO as string

interface RecordedCall {
  url: string
  headers: Record<string, string>
  body: {
    model?: string
    messages?: Array<{ role: string; content: string }>
    response_format?: { type: string }
    temperature?: number
    q?: string | string[]
    target?: string
  }
}

/** Extract the {"texts":[...]} payload from a user message. */
function sentTexts(userContent: string): string[] {
  const start = userContent.lastIndexOf('{')
  if (start < 0) return []
  try {
    return (JSON.parse(userContent.slice(start)) as { texts?: string[] }).texts ?? []
  } catch {
    return []
  }
}

async function child() {
  Object.entries({ ...BASE_ENV, ...SCENARIO_ENV[SCENARIO] }).forEach(([k, v]) => {
    process.env[k] = v
  })

  const calls: RecordedCall[] = []

  /** OpenAI-compatible chat completion success response. */
  const completion = (translations: string[]) => ({
    choices: [{ message: { role: 'assistant', content: JSON.stringify({ translations }) } }],
  })

  type Handler = (call: RecordedCall) => Response
  const handlerByScenario: Record<string, Handler> = {
    groq: (call) => Response.json(completion(sentTexts(call.body.messages?.[1]?.content ?? '').map((t) => `[RU] ${t}`))),
    'groq-rate-limit': (call) =>
      call.url.includes('api.groq.com')
        ? new Response('{"error":{"message":"Rate limit reached"}}', { status: 429, headers: { 'retry-after': '1' } })
        : Response.json(completion(sentTexts(call.body.messages?.[1]?.content ?? '').map((t) => `[RU] ${t}`))),
    'groq-model-fallback': (call) =>
      call.body.model === 'openai/gpt-oss-120b'
        ? new Response('{"error":{"code":"model_not_found","message":"The model openai/gpt-oss-120b does not exist or is decommissioned"}}', { status: 404 })
        : Response.json(completion(sentTexts(call.body.messages?.[1]?.content ?? '').map((t) => `[RU] ${t}`))),
    // Echo-back mock that DROPS the ⟦N⟧ placeholders — the fail-safe case.
    'groq-mangled-placeholder': () => Response.json(completion(['Протокол с рекордным значением'])),
    deepseek: (call) => Response.json(completion(sentTexts(call.body.messages?.[1]?.content ?? '').map((t) => `[RU] ${t}`))),
    gemini: (call) => Response.json(completion(sentTexts(call.body.messages?.[1]?.content ?? '').map((t) => `[RU] ${t}`))),
    'hashtag-protection': (call) => Response.json(completion(sentTexts(call.body.messages?.[1]?.content ?? '').map((t) => `[RU] ${t}`))),
    'libretranslate-only': () => new Response('not an llm endpoint', { status: 404 }),
  }

  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let parsedBody: RecordedCall['body'] = {}
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body)
      } catch {
        parsedBody = {}
      }
    }
    const call: RecordedCall = {
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: parsedBody,
    }
    calls.push(call)
    // LibreTranslate mock (same process — /languages + /translate).
    if (url.startsWith('http://lt.mock/languages')) {
      return Promise.resolve(Response.json([{ code: 'en', targets: ['ru', 'es'] }]))
    }
    if (url.startsWith('http://lt.mock/translate')) {
      const q = call.body.q
      const texts = Array.isArray(q) ? q : [String(q ?? '')]
      return Promise.resolve(Response.json({ translatedText: texts.length === 1 ? `[RU] ${texts[0]}` : texts.map((t) => `[RU] ${t}`) }))
    }
    return Promise.resolve(handlerByScenario[SCENARIO](call))
  }) as typeof fetch

  const { translateBatch, localeTranslatable, translationConfigured, activeTranslationProvider, __resetTranslationCaches } =
    await import('../src/lib/translate')

  const llmCalls = () => calls.filter((c) => c.url.includes('/chat/completions'))
  const ltCalls = () => calls.filter((c) => c.url.includes('lt.mock/translate'))
  const auth = (c: RecordedCall) => (c.headers as Record<string, string | undefined>)['Authorization'] ?? ''

  if (SCENARIO === 'groq') {
    ok('provider = groq (priority 1)', JSON.stringify(activeTranslationProvider()) === JSON.stringify({ id: 'groq', label: 'Groq', model: 'openai/gpt-oss-120b' }), JSON.stringify(activeTranslationProvider()))
    ok('translationConfigured() true via LLM key alone (no LibreTranslate)', translationConfigured())
    ok('LLM covers locales LibreTranslate cannot (th)', await localeTranslatable('th'))
    ok('no /languages probe happened (LLM skips the Argos gate)', calls.every((c) => !c.url.includes('/languages')))

    const r1 = await translateBatch(['Hello world', 'Another text'], 'ru')
    ok('batch translated via Groq', JSON.stringify(r1) === JSON.stringify(['[RU] Hello world', '[RU] Another text']), JSON.stringify(r1))
    const c1 = llmCalls()[0]
    ok('request goes to api.groq.com/openai/v1/chat/completions', c1?.url === 'https://api.groq.com/openai/v1/chat/completions', c1?.url)
    ok('Authorization: Bearer <key>', auth(c1) === 'Bearer test-groq-key', auth(c1))
    ok('model = openai/gpt-oss-120b', c1?.body.model === 'openai/gpt-oss-120b', String(c1?.body.model))
    ok('system prompt present and Web3-flavored', c1?.body.messages?.[0]?.role === 'system' && /Web3/.test(c1.body.messages[0].content) && /DeFi/.test(c1.body.messages[0].content))
    ok('system prompt demands exact ⟦N⟧ placeholder copying', /⟦0⟧/.test(c1?.body.messages?.[0]?.content ?? ''))
    ok('user message names the target language', (c1?.body.messages?.[1]?.content ?? '').includes('Russian (ru)'))
    ok('JSON mode requested', c1?.body.response_format?.type === 'json_object')
    ok('low temperature for deterministic translation', c1?.body.temperature === 0.2)

    // De-duplication: two identical tags + one unique → ONE text in the request.
    const before = llmCalls().length
    const r2 = await translateBatch(['remote', 'remote', 'rust'], 'ru')
    const c2 = llmCalls()[before]
    ok('identical strings de-duplicated before the request', sentTexts(c2?.body.messages?.[1]?.content ?? '').length === 2, JSON.stringify(c2?.body.messages?.[1]?.content))
    ok('result expanded back to the original length', JSON.stringify(r2) === JSON.stringify(['[RU] remote', '[RU] remote', '[RU] rust']), JSON.stringify(r2))

    // Blank strings are not sent to the provider.
    const before3 = llmCalls().length
    const r3 = await translateBatch(['', 'hello', '   '], 'ru')
    const c3 = llmCalls()[before3]
    ok('blank strings filtered out of the request', sentTexts(c3?.body.messages?.[1]?.content ?? '').length === 1)
    ok('blanks keep their original value in the result', JSON.stringify(r3) === JSON.stringify(['', '[RU] hello', '   ']), JSON.stringify(r3))

    // Glossary protection through the LLM lane.
    const before4 = llmCalls().length
    const r4 = await translateBatch(['DeFi protocol TVL report'], 'ru')
    const c4 = llmCalls()[before4]
    const user4 = c4?.body.messages?.[1]?.content ?? ''
    ok('glossary jargon replaced by ⟦N⟧ before leaving the process', /⟦\d+⟧/.test(user4) && !user4.includes('DeFi') && !user4.includes('TVL'), JSON.stringify(user4))
    ok('placeholder restored after the LLM round trip', r4?.[0] === '[RU] DeFi protocol TVL report', JSON.stringify(r4))
    ok('no placeholder leaked into the result', r4?.every((s) => !s.includes('⟦')) === true)
  }

  if (SCENARIO === 'groq-rate-limit') {
    ok('indicator still names Groq (config, not health)', activeTranslationProvider()?.id === 'groq')
    const r1 = await translateBatch(['Hello'], 'ru')
    ok('429 → falls back to LibreTranslate within the SAME call', r1?.[0] === '[RU] Hello', JSON.stringify(r1))
    ok('exactly one Groq attempt was made', llmCalls().length === 1, `llm calls=${llmCalls().length}`)
    ok('LibreTranslate served the fallback', ltCalls().length === 1)
    const r2 = await translateBatch(['World'], 'ru')
    ok('cooldown skips Groq on the next call', llmCalls().length === 1 && ltCalls().length === 2, `llm=${llmCalls().length} lt=${ltCalls().length}`)
    ok('second call still translated (via LibreTranslate)', r2?.[0] === '[RU] World', JSON.stringify(r2))
  }

  if (SCENARIO === 'groq-model-fallback') {
    const r1 = await translateBatch(['Hello'], 'ru')
    ok('model_not_found → next model in the list serves the batch', r1?.[0] === '[RU] Hello', JSON.stringify(r1))
    ok('both models were tried in order', llmCalls().map((c) => c.body.model).join(',') === 'openai/gpt-oss-120b,qwen/qwen3.8-27b', llmCalls().map((c) => c.body.model).join(','))
    const r2 = await translateBatch(['Again'], 'ru')
    ok('working model is remembered for subsequent calls', llmCalls().length === 3 && llmCalls()[2].body.model === 'qwen/qwen3.8-27b' && r2?.[0] === '[RU] Again', `${llmCalls().length} calls, last=${llmCalls()[2]?.body.model}`)
    ok('indicator reports the live model', activeTranslationProvider()?.model === 'qwen/qwen3.8-27b', String(activeTranslationProvider()?.model))
  }

  if (SCENARIO === 'groq-mangled-placeholder') {
    const r1 = await translateBatch(['DeFi protocol TVL report'], 'ru')
    ok('mangled ⟦N⟧ → whole batch fails safe to English (null)', r1 === null, JSON.stringify(r1))
    const r2 = await translateBatch(['Another text'], 'ru')
    ok('provider cooled down — no second doomed Groq round trip', llmCalls().length === 1 && r2 === null, `llm=${llmCalls().length}`)
  }

  if (SCENARIO === 'hashtag-protection') {
    // 1) Plain hashtags in a title: protected as ⟦N⟧, restored byte-identically.
    const r1 = await translateBatch(['Why #crypto needs #rust builders'], 'ru')
    ok(
      'hashtags restored byte-identically after the LLM round trip',
      r1?.[0] === '[RU] Why #crypto needs #rust builders',
      JSON.stringify(r1),
    )
    const c1 = llmCalls()[0]
    const user1 = c1?.body.messages?.[1]?.content ?? ''
    ok(
      'hashtags left the process as ⟦N⟧ placeholders (never raw)',
      /⟦\d+⟧/.test(user1) && !user1.includes('#crypto') && !user1.includes('#rust'),
      JSON.stringify(user1),
    )
    ok(
      'system prompt explicitly protects hashtags (search keywords)',
      /hashtag/i.test(c1?.body.messages?.[0]?.content ?? '') && /#crypto/.test(c1?.body.messages?.[0]?.content ?? ''),
    )

    // 2) A hashtag that CONTAINS a glossary term (#defi vs glossary "DeFi"):
    //    the hashtag pass runs FIRST, so the token is never split apart.
    const r2 = await translateBatch(['The #defi ecosystem grows'], 'ru')
    ok(
      'glossary term inside a hashtag stays one intact token (#defi)',
      r2?.[0] === '[RU] The #defi ecosystem grows',
      JSON.stringify(r2),
    )

    // 3) Markdown ATX headings are NOT hashtags — untouched, unmangled.
    const r3 = await translateBatch(['# Section heading', '## Another heading'], 'ru')
    ok(
      'markdown ATX headings are not treated as hashtags',
      r3?.[0] === '[RU] # Section heading' && r3?.[1] === '[RU] ## Another heading',
      JSON.stringify(r3),
    )

    // 4) Mixed protection: hashtags + glossary terms restore together.
    const r4 = await translateBatch(['#airdrop TVL report on DeFi'], 'ru')
    ok(
      'hashtags and glossary terms restore together in one string',
      r4?.[0] === '[RU] #airdrop TVL report on DeFi',
      JSON.stringify(r4),
    )
    ok('no placeholder leaked into any result', [r1, r2, r3, r4].every((r) => (r ?? []).every((s) => !s.includes('⟦'))))
  }

  if (SCENARIO === 'deepseek') {
    ok('provider = deepseek (priority 2)', activeTranslationProvider()?.id === 'deepseek' && activeTranslationProvider()?.model === 'deepseek-chat', JSON.stringify(activeTranslationProvider()))
    const r1 = await translateBatch(['Hello'], 'ru')
    ok('translated via DeepSeek', r1?.[0] === '[RU] Hello', JSON.stringify(r1))
    const c1 = llmCalls()[0]
    ok('request goes to api.deepseek.com/v1', c1?.url === 'https://api.deepseek.com/v1/chat/completions', c1?.url)
    ok('Authorization: Bearer <deepseek key>', auth(c1) === 'Bearer test-deepseek-key', auth(c1))
    ok('model = deepseek-chat', c1?.body.model === 'deepseek-chat', String(c1?.body.model))
  }

  if (SCENARIO === 'gemini') {
    ok('provider = gemini (priority 3)', activeTranslationProvider()?.id === 'gemini' && activeTranslationProvider()?.model === 'gemini-flash-latest', JSON.stringify(activeTranslationProvider()))
    const r1 = await translateBatch(['Hello'], 'ru')
    ok('translated via Gemini (OpenAI-compat endpoint)', r1?.[0] === '[RU] Hello', JSON.stringify(r1))
    const c1 = llmCalls()[0]
    ok('request goes to generativelanguage.googleapis.com/v1beta/openai', c1?.url === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', c1?.url)
    ok('response_format NOT sent (endpoint does not guarantee JSON mode)', c1?.body.response_format === undefined, JSON.stringify(c1?.body.response_format))
    ok('Authorization: Bearer <gemini key>', auth(c1) === 'Bearer test-gemini-key', auth(c1))
  }

  if (SCENARIO === 'libretranslate-only') {
    ok('provider = libretranslate when no LLM key is set', JSON.stringify(activeTranslationProvider()) === JSON.stringify({ id: 'libretranslate', label: 'self-hosted LibreTranslate', model: null }), JSON.stringify(activeTranslationProvider()))
    ok('locale outside the Argos list is not translatable (th)', (await localeTranslatable('th')) === false)
    ok('locale inside the Argos list is translatable (ru)', await localeTranslatable('ru'))
    const r1 = await translateBatch(['Hello'], 'ru')
    ok('translated via LibreTranslate', r1?.[0] === '[RU] Hello', JSON.stringify(r1))
    ok('no LLM endpoint was ever contacted', llmCalls().length === 0, `llm calls=${llmCalls().length}`)

    // Hashtag protection applies to the LibreTranslate lane as well.
    const r2 = await translateBatch(['Why #crypto needs #rust builders'], 'ru')
    ok(
      'hashtags protected through the LibreTranslate lane too',
      r2?.[0] === '[RU] Why #crypto needs #rust builders',
      JSON.stringify(r2),
    )
    const ltLast = ltCalls()[ltCalls().length - 1]
    ok(
      'LibreTranslate received ⟦N⟧ placeholders, not raw hashtags',
      Array.isArray(ltLast?.body.q) && /⟦\d+⟧/.test(String((ltLast.body.q as string[])[0])) && !String((ltLast.body.q as string[])[0]).includes('#crypto'),
      JSON.stringify(ltLast?.body.q),
    )
  }

  __resetTranslationCaches()
  globalThis.fetch = realFetch
  console.log(failures === 0 ? `  scenario "${SCENARIO}": ALL PASS` : `  scenario "${SCENARIO}": ${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

child().catch((e) => {
  console.error(`scenario "${SCENARIO}" crashed:`, e)
  process.exit(1)
})
