/**
 * LibreTranslate client — self-hosted machine translation for job content.
 *
 * Design constraints (this runs inside page renders, so it must NEVER be the
 * reason a page is slow or broken):
 *   • every request has a hard timeout (3.5 s) — a down/slow service degrades
 *     to the English original instead of hanging the render
 *   • a per-target circuit breaker: after one failure the target is skipped
 *     for 60 s, so a broken service costs at most one timeout per minute
 *   • the supported-target list is fetched once and cached for 10 minutes;
 *     locales without an Argos model (th, bn, … on default installs) are
 *     served the English original without a wasted API call
 *   • translation is BATCHED: an array of strings goes out as one POST
 *     /translate request (LibreTranslate supports `q: string[]`), chunked to
 *     stay under the default 5000-char request limit
 *
 * The DB-level cache (Post.translations) lives in src/lib/localize.ts — this
 * module is a pure transport client.
 *
 * Custom glossary (Web3 jargon protection): before a batch leaves the
 * process, glossary terms (src/lib/translation-glossary.ts) are swapped for
 * opaque ⟦N⟧ placeholders so LibreTranslate cannot touch them; after the
 * response returns, the placeholders are stitched back out with the
 * per-locale replacement. Cached translations therefore already contain the
 * final, glossary-corrected text.
 */
import { env } from './env'
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
/** Supported-language list cache TTL. */
const LANGUAGES_TTL_MS = 10 * 60_000

export function translationConfigured(): boolean {
  return Boolean(env.LIBRETRANSLATE_URL)
}

// ---------------------------------------------------------------------------
// Runtime caches (per server process)
// ---------------------------------------------------------------------------

/** target code → unix-ms until which the target is considered dead. */
const cooldownUntil = new Map<string, number>()
/** target code → true, cached "no Argos model for this pair". */
const unsupported = new Set<string>()
let languagesCache: { targets: Set<string> | null; fetchedAt: number } | null = null

function targetCooldownActive(target: string): boolean {
  const until = cooldownUntil.get(target) ?? 0
  return Date.now() < until
}

function tripCooldown(target: string): void {
  cooldownUntil.set(target, Date.now() + TARGET_COOLDOWN_MS)
}

// ---------------------------------------------------------------------------
// Supported targets
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
  if (!env.LIBRETRANSLATE_URL || locale === 'en') return false
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
// Glossary protection — ⟦N⟧ placeholders survive machine translation
// ---------------------------------------------------------------------------

/** Placeholder sent to LibreTranslate instead of the jargon term. */
const PLACEHOLDER_RE = /\s?⟦(\d+)⟧\s?/g
/** Locales written without spaces between words — restore without padding. */
const NO_SPACE_TARGET_RE = /^(zh|ja|ko|th)/

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

async function translateChunk(texts: string[], target: string): Promise<string[]> {
  const body: Record<string, unknown> = {
    q: texts,
    source: 'en',
    target,
    format: 'text',
  }
  if (env.LIBRETRANSLATE_API_KEY) body.api_key = env.LIBRETRANSLATE_API_KEY

  const res = await fetch(`${env.LIBRETRANSLATE_URL}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

/**
 * Translate a batch of strings English → target. Returns null on ANY failure
 * (timeout, unsupported target, bad payload) — callers fall back to the
 * originals. An empty array returns [] immediately.
 */
export async function translateBatch(texts: string[], locale: string): Promise<string[] | null> {
  if (texts.length === 0) return []
  if (!env.LIBRETRANSLATE_URL) return null
  const target = LT_CODE[locale] ?? locale
  if (target === 'en') return null
  if (unsupported.has(target) || targetCooldownActive(target)) return null

  try {
    const targets = await supportedTargets()
    if (targets && !targets.has(target)) {
      unsupported.add(target)
      return null
    }

    // Glossary protection: swap jargon terms for opaque placeholders before
    // anything leaves the process, so LibreTranslate cannot translate them.
    const glossary = await resolvedTermsForLocale(locale, target)
    const slotsPerText: Slot[][] = []
    const protectedTexts =
      glossary.length > 0
        ? texts.map((t) => {
            const slots: Slot[] = []
            const protectedText = protectText(t, glossary, slots)
            slotsPerText.push(slots)
            return protectedText
          })
        : texts

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

    if (slotsPerText.length === 0) return results
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
  __resetGlossaryCache()
}
