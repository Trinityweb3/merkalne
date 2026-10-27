/**
 * Machine-translation transport — job content English → 19 target locales.
 *
 * PROVIDER CHAIN (first configured wins, per request):
 *   1. Groq      (GROQ_API_KEY)      — OpenAI-compatible, free tier,
 *                                      models: openai/gpt-oss-120b → qwen/qwen3.8-27b
 *   2. DeepSeek  (DEEPSEEK_API_KEY)  — OpenAI-compatible (deepseek-chat)
 *   3. Gemini    (GOOGLE_AI_API_KEY) — Google AI Studio OpenAI-compat endpoint
 *   4. LibreTranslate (LIBRETRANSLATE_URL) — self-hosted final fallback
 *
 * If the active LLM provider fails (timeout, 429, 5xx, bad payload) the SAME
 * request transparently falls through to LibreTranslate, so a rate-limited
 * Groq free tier never leaves pages in English. A failed provider is put on a
 * short cooldown (60 s, or the 429 Retry-After) and skipped until it recovers.
 *
 * Design constraints (this runs inside page renders, so it must NEVER be the
 * reason a page is slow or broken):
 *   • every request has a hard, payload-scaled timeout — a down/slow service
 *     degrades to the English original instead of hanging the render
 *   • LLM requests are serialized per provider with a minimum spacing
 *     (Groq free tier = 30 req/min → ~2.1 s between calls) so a burst of
 *     concurrent renders cannot burn the whole RPM budget in one second
 *   • a per-target circuit breaker for LibreTranslate: after one failure the
 *     target is skipped for 60 s
 *   • the LibreTranslate supported-target list is fetched once and cached for
 *     10 minutes; locales without an Argos model are served the English
 *     original without a wasted API call. LLM providers cover every site
 *     locale, so they skip that gate entirely.
 *   • translation is BATCHED: an array of strings goes out as one request,
 *     chunked to stay under sensible payload limits. The LLM lane also
 *     de-duplicates identical strings (a list of 24 posts shares the same
 *     "remote" tag — translating it 24 times would waste free-tier tokens)
 *
 * The DB-level cache (Post.translations) lives in src/lib/localize.ts — this
 * module is a pure transport client.
 *
 * Custom glossary (Web3 jargon protection): before a batch leaves the
 * process, glossary terms (src/lib/translation-glossary.ts) are swapped for
 * opaque ⟦N⟧ placeholders so no provider can touch them; after the response
 * returns, the placeholders are stitched back out with the per-locale
 * replacement. Cached translations therefore already contain the final,
 * glossary-corrected text.
 *
 * Hashtag protection (functional identifiers): words starting with "#"
 * (#crypto, #defi, #rust …) are swapped for the same ⟦N⟧ placeholders FIRST —
 * before the glossary pass, so a glossary term inside a hashtag ("#defi")
 * cannot be split apart — and are restored byte-identically in EVERY locale.
 * Hashtags are functional identifiers (they feed /search?q=%23tag lookups and
 * tag filters), so they must never be translated, not even partially. This
 * runs in BOTH lanes (LLM and LibreTranslate): the placeholder mechanism is
 * provider-agnostic, and the system prompt additionally instructs the LLM to
 * leave hashtags alone (belt and suspenders).
 */
import { env } from './env'
import { LANGUAGES } from './constants'
import { resolvedTermsForLocale, __resetGlossaryCache, type ResolvedTerm } from './translation-glossary'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** next-intl locale → LibreTranslate/Argos language code (only the outliers). */
const LT_CODE: Record<string, string> = {
  fil: 'tl', // Tagalog ships as "tl" in Argos/LibreTranslate
}

const REQUEST_TIMEOUT_MS = 3_500
const CHAR_LIMIT_PER_REQUEST = 4_000 // LibreTranslate default is 5000 — headroom
const MAX_STRINGS_PER_REQUEST = 32
/** Circuit breaker: skip a target for this long after a failure. */
const TARGET_COOLDOWN_MS = 60_000
/** Circuit breaker: skip an LLM provider for this long after a failure. */
const LLM_COOLDOWN_MS = 60_000
/** Supported-language list cache TTL. */
const LANGUAGES_TTL_MS = 10 * 60_000

/**
 * ADAPTIVE per-chunk timeout. A fixed 3.5 s budget only ever works for short
 * strings: self-hosted LibreTranslate runs Argos models on the CPU, and a
 * 4 000-char body chunk routinely needs 10–30 s on a small VPS. A too-short
 * timeout made title translation succeed while EVERY body/snippet batch
 * timed out — the exact "titles translate, bodies stay English" production
 * bug. Scale the budget with the payload (≈6 ms/char ≈ 165 chars/s — slower
 * than any real Argos instance) and cap it at 60 s per chunk.
 */
const MAX_CHUNK_TIMEOUT_MS = 60_000
const CHUNK_TIMEOUT_MS_PER_CHAR = 6
function chunkTimeoutMs(totalChars: number): number {
  return Math.min(MAX_CHUNK_TIMEOUT_MS, REQUEST_TIMEOUT_MS + totalChars * CHUNK_TIMEOUT_MS_PER_CHAR)
}

// ---------------------------------------------------------------------------
// LLM provider chain (Groq → DeepSeek → Gemini)
// ---------------------------------------------------------------------------

type LlmProviderId = 'groq' | 'deepseek' | 'gemini'

interface LlmProvider {
  id: LlmProviderId
  /** Human label for logs + the About-page indicator. */
  label: string
  baseUrl: string
  apiKey: string
  /** Preference order; a decommissioned model is skipped permanently. */
  models: string[]
  /** Free-tier RPM → in-process minimum spacing between requests. */
  minIntervalMs: number
  /** response_format:{type:'json_object'} support (omitted for Gemini). */
  jsonMode: boolean
  /** Provider-specific body extensions. */
  extras?: Record<string, unknown>
}

/**
 * Groq free tier (no credit card): 30 RPM / 1 000 RPD on openai/gpt-oss-120b
 * → 2.1 s spacing keeps us at ≈28 RPM. qwen/qwen3.8-27b is the fallback
 * model (same free tier). reasoning_effort "low" is enough for translation
 * and saves tokens; reasoning_format "hidden" keeps  musing out of .content.
 */
const GROQ_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']

function activeLlmProvider(): LlmProvider | null {
  if (env.GROQ_API_KEY) {
    return {
      id: 'groq',
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: env.GROQ_API_KEY,
      models: GROQ_MODELS,
      minIntervalMs: 2_100,
      jsonMode: true,
      extras: { temperature: 0.2, reasoning_effort: 'low', reasoning_format: 'hidden', max_completion_tokens: 8_192 },
    }
  }
  if (env.DEEPSEEK_API_KEY) {
    return {
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: env.DEEPSEEK_API_KEY,
      models: ['deepseek-chat'],
      minIntervalMs: 300,
      jsonMode: true,
      extras: { temperature: 0.2, max_tokens: 8_192 },
    }
  }
  if (env.GOOGLE_AI_API_KEY) {
    return {
      id: 'gemini',
      label: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: env.GOOGLE_AI_API_KEY,
      // gemini-flash-latest tracks the current stable Flash; 2.5-flash is the
      // pinned fallback if the alias is ever retired.
      models: ['gemini-flash-latest', 'gemini-2.5-flash'],
      minIntervalMs: 4_300, // AI Studio free tier ≈ 10–15 RPM
      jsonMode: false,
      extras: { temperature: 0.2, max_tokens: 8_192 },
    }
  }
  return null
}

/** Info for the About-page indicator ("Translation via Groq · model"). */
export interface TranslationProviderInfo {
  id: LlmProviderId | 'libretranslate'
  label: string
  model: string | null
}

/**
 * Which provider is configured RIGHT NOW (pure config, no health probe — a
 * transient cooldown does not flip the indicator). Null = translation off.
 */
export function activeTranslationProvider(): TranslationProviderInfo | null {
  const llm = activeLlmProvider()
  if (llm) {
    return { id: llm.id, label: llm.label, model: llm.models[llmModelIdx.get(llm.id) ?? 0] }
  }
  if (env.LIBRETRANSLATE_URL) {
    return { id: 'libretranslate', label: 'self-hosted LibreTranslate', model: null }
  }
  return null
}

// ---------------------------------------------------------------------------
// Runtime caches (per server process)
// ---------------------------------------------------------------------------

/** target code → unix-ms until which the target is considered dead. */
const cooldownUntil = new Map<string, number>()
/** target code → true, cached "no Argos model for this pair". */
const unsupported = new Set<string>()
let languagesCache: { targets: Set<string> | null; fetchedAt: number } | null = null

/** LLM provider id → unix-ms until which the provider is skipped. */
const llmCooldownUntil = new Map<LlmProviderId, number>()
/** LLM provider id → index into provider.models of the last working model. */
const llmModelIdx = new Map<LlmProviderId, number>()
/** Per-provider serialized + spaced request gates. */
const llmGates = new Map<LlmProviderId, ProviderGate>()
/** Providers already announced in the logs (once per process). */
const announced = new Set<LlmProviderId>()

function targetCooldownActive(target: string): boolean {
  const until = cooldownUntil.get(target) ?? 0
  return Date.now() < until
}

function tripCooldown(target: string): void {
  cooldownUntil.set(target, Date.now() + TARGET_COOLDOWN_MS)
}

function llmCooldownActive(id: LlmProviderId): boolean {
  const until = llmCooldownUntil.get(id) ?? 0
  return Date.now() < until
}

function tripLlmCooldown(id: LlmProviderId, ms: number = LLM_COOLDOWN_MS): void {
  llmCooldownUntil.set(id, Date.now() + ms)
}

/**
 * Serializes a provider's requests and enforces a minimum spacing between
 * them (free-tier RPM budgeting). Concurrent renders queue here instead of
 * firing a burst that trips 429s; the render budget race in localize.ts
 * keeps pages fast while the queue drains in the background.
 */
class ProviderGate {
  private chain: Promise<unknown> = Promise.resolve()
  private lastStart = 0
  constructor(private readonly minIntervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const waitMs = this.lastStart + this.minIntervalMs - Date.now()
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
      this.lastStart = Date.now()
      return fn()
    })
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function gateFor(provider: LlmProvider): ProviderGate {
  let gate = llmGates.get(provider.id)
  if (!gate) {
    gate = new ProviderGate(provider.minIntervalMs)
    llmGates.set(provider.id, gate)
  }
  return gate
}

// ---------------------------------------------------------------------------
// Supported targets (LibreTranslate only — LLM providers cover every locale)
// ---------------------------------------------------------------------------

/**
 * Locales LibreTranslate can translate English into (null = unknown/failed —
 * callers proceed optimistically and let the request itself decide).
 */
async function supportedTargets(): Promise<Set<string> | null> {
  if (!env.LIBRETRANSLATE_URL) return null
  if (languagesCache && Date.now() - languagesCache.fetchedAt < LANGUAGES_TTL_MS) {
    return languagesCache.targets
  }
  try {
    const res = await fetch(`${env.LIBRETRANSLATE_URL}/languages`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: env.LIBRETRANSLATE_API_KEY ? { Authorization: `Bearer ${env.LIBRETRANSLATE_API_KEY}` } : undefined,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const langs = (await res.json()) as Array<{ code: string; targets?: string[] }>
    const english = langs.find((l) => l.code === 'en')
    const targets = new Set(english?.targets ?? langs.map((l) => l.code))
    languagesCache = { targets, fetchedAt: Date.now() }
    return targets
  } catch {
    // Don't cache failures aggressively — retry next time, but don't block.
    languagesCache = { targets: null, fetchedAt: Date.now() - LANGUAGES_TTL_MS + 30_000 }
    return null
  }
}

/** Public helper: should we even try this next-intl locale? */
export async function localeTranslatable(locale: string): Promise<boolean> {
  if (locale === 'en') return false
  // LLM providers speak every site locale — skip the Argos availability gate.
  if (activeLlmProvider()) return true
  if (!env.LIBRETRANSLATE_URL) return false
  const target = LT_CODE[locale] ?? locale
  if (unsupported.has(target) || targetCooldownActive(target)) return false
  const targets = await supportedTargets()
  if (targets && !targets.has(target)) {
    unsupported.add(target)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], maxItems: number, maxChars: (t: T) => number, maxCharsTotal: number): T[][] {
  const out: T[][] = []
  let batch: T[] = []
  let chars = 0
  for (const item of items) {
    const c = maxChars(item)
    if (batch.length >= maxItems || (batch.length > 0 && chars + c > maxCharsTotal)) {
      out.push(batch)
      batch = []
      chars = 0
    }
    batch.push(item)
    chars += c
  }
  if (batch.length > 0) out.push(batch)
  return out
}

// ---------------------------------------------------------------------------
// Placeholder protection — ⟦N⟧ tokens survive machine translation
// ---------------------------------------------------------------------------

/** Placeholder sent to the provider instead of the jargon term. */
const PLACEHOLDER_RE = /\s?⟦(\d+)⟧\s?/g
/** Locales written without spaces between words — restore without padding. */
const NO_SPACE_TARGET_RE = /^(zh|ja|ko|th)/

/**
 * A hashtag token: "#" immediately followed by a letter/digit/underscore and
 * then more of the same (#crypto, #defi, #rust, #web3, #1inch). Markdown ATX
 * headings ("# Title", "## Title") never match because a space follows the
 * last "#"; an anchor inside a URL ("…/page#section") matches but is supposed
 * to stay byte-identical anyway, so protecting it is also correct.
 */
const HASHTAG_RE = /#[\p{L}\p{N}_][\p{L}\p{N}_]*/gu

/** Regex for one glossary term: unicode-aware boundaries, case-insensitive. */
function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu')
}

/** Matched source text + the replacement to stitch back in. */
interface Slot {
  replacement: string
}

/**
 * Replace every hashtag (#crypto …) with ⟦N⟧. Hashtags are functional
 * identifiers — they power /search?q=%23tag lookups and tag filtering — so
 * they must come back byte-identically in every locale. Runs BEFORE the
 * glossary pass so a glossary term inside a hashtag ("#defi" when "DeFi" is
 * a protected term) can never be split apart.
 */
function protectHashtags(text: string, slots: Slot[]): string {
  return text.replace(HASHTAG_RE, (matched) => {
    slots.push({ replacement: matched }) // identity restore — exact token
    return `⟦${slots.length - 1}⟧`
  })
}

/**
 * One text through the full protection pipeline: hashtags first, then
 * glossary terms. Both share the same slot array, so `restoreText` stitches
 * everything back in a single pass.
 */
function protectOne(text: string, terms: ResolvedTerm[], slots: Slot[]): string {
  return protectText(protectHashtags(text, slots), terms, slots)
}

/**
 * Protect a whole batch (used identically by the LLM and LibreTranslate
 * lanes). Returns the protected texts plus the per-text slot lists for the
 * restore pass.
 */
function protectBatch(
  texts: string[],
  glossary: ResolvedTerm[],
): { protectedTexts: string[]; slotsPerText: Slot[][] } {
  const slotsPerText: Slot[][] = []
  const protectedTexts = texts.map((t) => {
    const slots: Slot[] = []
    const protectedText = protectOne(t, glossary, slots)
    slotsPerText.push(slots)
    return protectedText
  })
  return { protectedTexts, slotsPerText }
}

/**
 * Replace every glossary term in `text` with ⟦N⟧. `slots` is shared across
 * the whole batch so each string keeps its own numbering; returns the
 * protected text (or the original when nothing matched).
 */
function protectText(text: string, terms: ResolvedTerm[], slots: Slot[]): string {
  let out = text
  for (const { term, map } of terms) {
    const replacement = Object.values(map)[0] ?? term
    out = out.replace(termRegex(term), (matched) => {
      // Identity mapping → keep the casing exactly as the author wrote it
      // ("on-chain" stays lowercase mid-sentence, "On-chain" at the start).
      const restoreAs = replacement.toLowerCase() === matched.toLowerCase() ? matched : replacement
      slots.push({ replacement: restoreAs })
      return `⟦${slots.length - 1}⟧`
    })
  }
  return out
}

/**
 * Stitch placeholders back in. Keeps at most one original space on each side
 * (models love to add/remove spacing around unusual tokens), and drops
 * spacing entirely for CJK-style targets. Returns null if a placeholder was
 * lost or mangled — the caller then serves the protected-free English
 * original rather than showing "⟦0⟧" to readers.
 */
function restoreText(text: string, slots: Slot[], target: string): string | null {
  let seen = 0
  let out = text.replace(PLACEHOLDER_RE, (full: string, idxStr: string) => {
    const slot = slots[Number(idxStr)]
    if (!slot) return full
    seen += 1
    return NO_SPACE_TARGET_RE.test(target) ? slot.replacement : `${full.startsWith(' ') ? ' ' : ''}${slot.replacement}${full.endsWith(' ') ? ' ' : ''}`
  })
  if (seen !== slots.length || /⟦\d+⟧/.test(out)) {
    // A placeholder survived unreplaced (model mangled the brackets) or one
    // went missing — surface nothing broken, just fail this batch loudly
    // enough to be debuggable and fall back to English upstream.
    console.warn(
      `[translate] glossary restore mismatch (${seen}/${slots.length} placeholders) — target ${target}`,
    )
    return null
  }
  return out
}

// ---------------------------------------------------------------------------
// LibreTranslate transport (final fallback)
// ---------------------------------------------------------------------------

async function translateChunk(texts: string[], target: string): Promise<string[]> {
  const body: Record<string, unknown> = {
    q: texts,
    source: 'en',
    target,
    format: 'text',
  }
  if (env.LIBRETRANSLATE_API_KEY) body.api_key = env.LIBRETRANSLATE_API_KEY

  const totalChars = texts.reduce((n, t) => n + t.length, 0)
  const res = await fetch(`${env.LIBRETRANSLATE_URL}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(chunkTimeoutMs(totalChars)),
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`LibreTranslate HTTP ${res.status}`)
  }
  const payload = (await res.json()) as { translatedText?: string | string[] }
  if (Array.isArray(payload.translatedText)) {
    if (payload.translatedText.length !== texts.length) {
      throw new Error(`LibreTranslate returned ${payload.translatedText.length}/${texts.length} strings`)
    }
    return payload.translatedText
  }
  if (typeof payload.translatedText === 'string' && texts.length === 1) return [payload.translatedText]
  throw new Error('LibreTranslate returned an unexpected payload shape')
}

// ---------------------------------------------------------------------------
// LLM transport (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

/** LLM request timeout: fast models, payload-scaled, hard-capped. */
const LLM_TIMEOUT_BASE_MS = 12_000
const LLM_TIMEOUT_MS_PER_CHAR = 3
function llmTimeoutMs(totalChars: number): number {
  return Math.min(MAX_CHUNK_TIMEOUT_MS, LLM_TIMEOUT_BASE_MS + totalChars * LLM_TIMEOUT_MS_PER_CHAR)
}

class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`rate limited (retry after ${retryAfterMs} ms)`)
  }
}
class ModelUnavailableError extends Error {}

/** Locale code → the English name used in the prompt ("ru" → "Russian"). */
function languageName(locale: string): string {
  return LANGUAGES.find((l) => l.code === locale)?.label ?? locale
}

/**
 * Robust Web3 translation system prompt. The glossary layer has already
 * swapped protected jargon for ⟦N⟧ placeholders — the prompt's job is to keep
 * them (and URLs/tickers/handles) byte-identical and to return strict JSON.
 */
function systemPrompt(locale: string): string {
  const name = languageName(locale)
  return [
    `You are the localization engine of Merklane, a Web3 careers publication. Translate job postings and editorial text from English into ${name}.`,
    '',
    'Hard rules:',
    `1. Translate idiomatically for a native ${name} reader from the crypto/Web3 industry — natural phrasing, never word-for-word.`,
    '2. Web3 terminology must stay accurate and industry-standard: DeFi, on-chain, TVL, AMM, DEX, CEX, DAO, NFT, Layer 2, L1/L2, stablecoin, airdrop, yield farming, staking, restaking, rollup, zkEVM, smart contract, wallet, gas fees, testnet, mainnet. Use the term the ' + name + ' crypto community actually uses; when no established translation exists, keep the English term as-is.',
    '3. Never translate or alter: URLs, e-mail addresses, @usernames, $TICKER symbols, hashtags (words starting with #, e.g. #crypto, #defi, #rust), code snippets, and placeholders of the form ⟦0⟧, ⟦1⟧, ⟦2⟧ … Copy every placeholder EXACTLY as given — same brackets, same digits, same position. Hashtags are search keywords: keep them in English exactly as written, never localize or transliterate them.',
    '4. Preserve the tone (professional but human) and the Markdown structure of each text: headings, bullet lists, bold, links, line breaks.',
    '5. You receive a JSON object {"texts": [...]} and must answer with ONLY a JSON object {"translations": [...]} with exactly the same number of items, in the same order. No explanations, no markdown fences.',
  ].join('\n')
}

function userMessage(texts: string[], locale: string, target: string): string {
  return `Target language: ${languageName(locale)} (${target}). Translate the ${texts.length} text${texts.length === 1 ? '' : 's'} below.\n${JSON.stringify({ texts })}`
}

/**
 * Pull {"translations": [...]} (or a bare JSON array) out of a completion.
 * Tolerates  musing blocks, markdown fences and small amounts of surrounding
 * prose; strict about the item count.
 */
function parseLlmTranslations(content: string, expected: number): string[] | null {
  let s = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  const candidates: unknown[] = []
  const tryParse = (raw: string): boolean => {
    try {
      candidates.push(JSON.parse(raw))
      return true
    } catch {
      return false
    }
  }
  tryParse(s)
  if (!/^[[{]/.test(s)) {
    const objStart = s.indexOf('{')
    const objEnd = s.lastIndexOf('}')
    if (objStart >= 0 && objEnd > objStart) tryParse(s.slice(objStart, objEnd + 1))
    const arrStart = s.indexOf('[')
    const arrEnd = s.lastIndexOf(']')
    if (arrStart >= 0 && arrEnd > arrStart) tryParse(s.slice(arrStart, arrEnd + 1))
  }
  for (const parsed of candidates) {
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { translations?: unknown }).translations)
        ? ((parsed as { translations: unknown[] }).translations)
        : null
    if (arr && arr.length === expected && arr.every((v) => typeof v === 'string')) {
      return arr as string[]
    }
  }
  return null
}

/** One chat-completion round trip. Throws RateLimitError / ModelUnavailableError / Error. */
async function chatCompletion(
  provider: LlmProvider,
  model: string,
  texts: string[],
  locale: string,
  target: string,
): Promise<string[]> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt(locale) },
      { role: 'user', content: userMessage(texts, locale, target) },
    ],
  }
  if (provider.jsonMode) body.response_format = { type: 'json_object' }
  if (provider.extras) Object.assign(body, provider.extras)

  const totalChars = texts.reduce((n, t) => n + t.length, 0)
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(llmTimeoutMs(totalChars)),
    cache: 'no-store',
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    if (res.status === 429) {
      const ra = res.headers.get('retry-after')
      let ms = 30_000
      if (ra) {
        const secs = Number(ra)
        ms = Number.isFinite(secs) && secs > 0 ? secs * 1_000 : Math.max(0, Date.parse(ra) - Date.now())
      }
      throw new RateLimitError(Math.max(ms, 5_000))
    }
    if (
      res.status === 404 ||
      /model_not_found|decommissioned|model not found|not a valid model|does not exist/i.test(errText)
    ) {
      throw new ModelUnavailableError(`HTTP ${res.status}: ${errText.slice(0, 180)}`)
    }
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 180)}`)
  }
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> | null } }>
  }
  const content = payload.choices?.[0]?.message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => p?.text ?? '').join('')
        : null
  if (text === null || !text.trim()) throw new Error('empty completion content')
  const parsed = parseLlmTranslations(text, texts.length)
  if (!parsed) throw new Error(`unparseable completion: ${text.slice(0, 120)}`)
  return parsed
}

/**
 * Translate a (protected) batch via the active LLM provider. De-duplicates
 * identical strings, drops blanks, chunks to provider-friendly sizes, walks
 * the model list on model_not_found. Throws on failure — the caller decides
 * whether to fall through to LibreTranslate.
 */
async function llmTranslateTexts(provider: LlmProvider, texts: string[], locale: string, target: string): Promise<string[]> {
  // Drop blanks (nothing to translate) and de-duplicate identical strings —
  // a list view repeats the same tags on every card, and free-tier tokens
  // are precious. Results are expanded back to the original shape below.
  const unique: string[] = []
  const uniqueIdx = new Map<string, number>()
  texts.forEach((t) => {
    if (!t.trim() || uniqueIdx.has(t)) return
    uniqueIdx.set(t, unique.length)
    unique.push(t)
  })

  const batches = chunk(
    unique,
    MAX_STRINGS_PER_REQUEST,
    (t) => t.length,
    CHAR_LIMIT_PER_REQUEST,
  )

  const uniqueResults: string[] = []
  for (const batch of batches) {
    // Walk the model list: a 404/decommissioned model is skipped for good
    // (the working index is remembered for subsequent calls).
    const startIdx = llmModelIdx.get(provider.id) ?? 0
    let lastErr: unknown = null
    let done = false
    for (let k = 0; k < provider.models.length && !done; k++) {
      const idx = (startIdx + k) % provider.models.length
      const model = provider.models[idx]
      try {
        const out = await gateFor(provider).run(() => chatCompletion(provider, model, batch, locale, target))
        llmModelIdx.set(provider.id, idx)
        if (!announced.has(provider.id)) {
          announced.add(provider.id)
          console.log(`[translate] LLM provider active: ${provider.label} (${model})`)
        }
        uniqueResults.push(...out)
        done = true
      } catch (err) {
        lastErr = err
        if (err instanceof ModelUnavailableError && k < provider.models.length - 1) {
          console.warn(`[translate] ${provider.label} model "${model}" unavailable — trying next model`)
          continue
        }
        throw err
      }
    }
    if (!done) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  // Expand back: blanks keep their original value, duplicates share one result.
  return texts.map((t) => (t.trim() ? uniqueResults[uniqueIdx.get(t) as number] : t))
}

/**
 * LLM lane with glossary protection + restore. Never throws — returns null
 * on any failure after tripping the provider cooldown.
 */
async function translateViaLlm(
  provider: LlmProvider,
  texts: string[],
  locale: string,
  target: string,
  glossary: ResolvedTerm[],
): Promise<string[] | null> {
  try {
    // Hashtag + glossary protection: hashtags first (functional identifiers
    // come back byte-identically), then jargon terms — one shared slot list.
    const { protectedTexts, slotsPerText } = protectBatch(texts, glossary)
    const results = await llmTranslateTexts(provider, protectedTexts, locale, target)
    const restored: string[] = []
    for (let i = 0; i < results.length; i++) {
      const fixed = restoreText(results[i], slotsPerText[i] ?? [], target)
      if (fixed === null) {
        // The model mangled a ⟦N⟧ placeholder — a provider-quality failure.
        // Cool the provider down so the next batches go straight to
        // LibreTranslate instead of burning a doomed round trip each time.
        tripLlmCooldown(provider.id)
        console.warn(`[translate] ${provider.label} mangled glossary placeholders — LibreTranslate takes over for ${LLM_COOLDOWN_MS / 1000}s`)
        return null
      }
      restored.push(fixed)
    }
    return restored
  } catch (err) {
    const cooldownMs = err instanceof RateLimitError ? Math.max(err.retryAfterMs, 30_000) : LLM_COOLDOWN_MS
    tripLlmCooldown(provider.id, cooldownMs)
    console.warn(
      `[translate] ${provider.label} failed (${String(err)}) — falling back to LibreTranslate for ${Math.round(cooldownMs / 1000)}s`,
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function translationConfigured(): boolean {
  return Boolean(activeLlmProvider() || env.LIBRETRANSLATE_URL)
}

/**
 * Translate a batch of strings English → target. Returns null on ANY failure
 * (timeout, unsupported target, bad payload) — callers fall back to the
 * originals. An empty array returns [] immediately.
 */
export async function translateBatch(texts: string[], locale: string): Promise<string[] | null> {
  if (texts.length === 0) return []
  const target = LT_CODE[locale] ?? locale
  if (target === 'en') return null

  // ---- Lane 1: LLM provider (Groq → DeepSeek → Gemini, first configured) --
  const llm = activeLlmProvider()
  if (llm && !llmCooldownActive(llm.id)) {
    const glossary = await resolvedTermsForLocale(locale, target)
    const viaLlm = await translateViaLlm(llm, texts, locale, target, glossary)
    if (viaLlm) return viaLlm
    // else: provider failed (cooldown tripped) — fall through to LibreTranslate
  }

  // ---- Lane 2: self-hosted LibreTranslate (final fallback) ----------------
  if (!env.LIBRETRANSLATE_URL) return null
  if (unsupported.has(target) || targetCooldownActive(target)) return null

  try {
    const targets = await supportedTargets()
    if (targets && !targets.has(target)) {
      unsupported.add(target)
      return null
    }

    // Protection: hashtags first (functional identifiers), then glossary
    // jargon — anything protected leaves the process as opaque ⟦N⟧ tokens
    // that neither an LLM nor LibreTranslate can touch.
    const glossary = await resolvedTermsForLocale(locale, target)
    const { protectedTexts, slotsPerText } = protectBatch(texts, glossary)

    const batches = chunk(
      protectedTexts,
      MAX_STRINGS_PER_REQUEST,
      (t) => t.length,
      CHAR_LIMIT_PER_REQUEST,
    )
    const results: string[] = []
    for (const batch of batches) {
      results.push(...(await translateChunk(batch, target)))
    }

    // Restore hashtags + glossary terms. An empty slot list passes the text
    // through untouched (nothing was protected for that string).
    const restored: string[] = []
    for (let i = 0; i < results.length; i++) {
      const fixed = restoreText(results[i], slotsPerText[i] ?? [], target)
      if (fixed === null) return null // mangled placeholder — serve English
      restored.push(fixed)
    }
    return restored
  } catch (err) {
    tripCooldown(target)
    console.warn(`[translate] ${locale}→${target} failed (${String(err)}) — serving English for ${TARGET_COOLDOWN_MS / 1000}s`)
    return null
  }
}

/** Test seam: reset the in-process caches (used by the QA mock harness). */
export function __resetTranslationCaches(): void {
  cooldownUntil.clear()
  unsupported.clear()
  languagesCache = null
  llmCooldownUntil.clear()
  llmModelIdx.clear()
  llmGates.clear()
  announced.clear()
  __resetGlossaryCache()
}
