/**
 * Merklane Ads — campaign targeting helpers.
 *
 * Targeting is stored as normalised comma-separated strings on Campaign
 * (portable CSV instead of scalar lists — see the modelling rules at the
 * top of prisma/schema.prisma):
 *
 *   targetSections   "intern-junior,mid-senior"   (POST_SECTIONS slugs)
 *   targetLocales    "en,ru"                      (interface locale codes)
 *   targetKeywords   "solidity,smart contracts"   (lowercase phrases)
 *   keywordMatch     "phrase" | "exact"           (how keywords match)
 *   countryMode      "all" | "include" | "exclude"
 *   targetCountries  "DE,US"                      (ISO 3166-1 alpha-2)
 *   targetHashtags   "web3,jobs"                  (lowercase, no "#")
 *
 * Empty string = no restriction: the campaign matches EVERYTHING in that
 * dimension. The auction engine (src/lib/ads/auction.ts) uses
 * `targetingMatches()` to drop campaigns that exclude the page currently
 * being served; the campaign API uses the parse/sanitize helpers to
 * validate the advertiser's selection.
 *
 * UNKNOWN-INVENTORY RULE (Phase 1, kept for the new dimensions): a campaign
 * that restricts a dimension never buys inventory that carries NO context
 * for it — a keyword-targeted campaign does not serve on pages without a
 * keyword context, an include/exclude country campaign does not serve when
 * the visitor's country is unknown. Only "no restriction" campaigns match
 * context-less requests.
 */
import { LANGUAGES, POST_SECTIONS, SECTION_META, type PostSection } from '@/lib/constants'

/** Section contexts the serve API accepts (content sections + the homepage). */
export const AD_SECTION_CONTEXTS: readonly string[] = [...POST_SECTIONS, 'home']

/** Every interface locale code (en, ru, …). */
export const AD_LOCALE_CODES: readonly string[] = LANGUAGES.map((l) => l.code)

// ---------------------------------------------------------------------------
// Bounds (mirrored by the Zod schemas in the campaign API routes)
// ---------------------------------------------------------------------------

/** Max keyword phrases per campaign. */
export const MAX_KEYWORDS = 10
/** Max characters per keyword phrase. */
export const KEYWORD_MAX_LEN = 60
/** Max hashtags per campaign. */
export const MAX_HASHTAGS = 10
/** Max characters per hashtag (without "#"). */
export const HASHTAG_MAX_LEN = 40
/** Max ISO country codes per campaign. */
export const MAX_COUNTRIES = 20

export type KeywordMatch = 'phrase' | 'exact'
export type CountryMode = 'all' | 'include' | 'exclude'

/**
 * Split a stored CSV list into a clean array: trims, lower-cases, drops
 * empties and duplicates while preserving order.
 */
export function parseTargetingCsv(csv: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of (csv ?? '').split(',')) {
    const value = part.trim().toLowerCase()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Parse advertiser keyword input: commas separate phrases; every phrase is
 * trimmed + lower-cased; empties and duplicates dropped. Phrase-mode
 * keywords keep internal spaces ("smart contracts"), exact-mode input works
 * the same way (an exact phrase is compared as a whole).
 */
export function parseKeywordInput(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!value || value.length > KEYWORD_MAX_LEN || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

/**
 * Parse advertiser hashtag input: strips a leading "#", trims, lower-cases.
 * A "#Web3" chip and "web3" are the same tag; the stored form never keeps
 * the "#" (page tags are stored the same way).
 */
export function parseHashtagInput(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw
      .trim()
      .toLowerCase()
      .replace(/^#+/, '')
      .replace(/\s+/g, '-')
    if (!value || value.length > HASHTAG_MAX_LEN || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= MAX_HASHTAGS) break
  }
  return out
}

/** ISO 3166-1 alpha-2 validation ("de" → "DE"; anything else → null). */
export function normalizeCountryCode(raw: string): string | null {
  const value = raw.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(value) ? value : null
}

/** Validate + normalise a list of country codes (drops invalid entries). */
export function parseCountryInput(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const code = normalizeCountryCode(raw)
    if (!code || seen.has(code)) continue
    seen.add(code)
    out.push(code)
    if (out.length >= MAX_COUNTRIES) break
  }
  return out
}

/** Serialise a selection back into the stored CSV form ("" when empty). */
export function toTargetingCsv(values: readonly string[]): string {
  return sanitizeTargeting(values).join(',')
}

/**
 * Validate a client-supplied selection: keeps only known section slugs /
 * locale codes (unknown values are silently dropped — the UI only offers
 * valid ones, so this is defence in depth against hand-crafted requests).
 */
export function sanitizeTargeting(values: readonly string[]): string[] {
  return parseTargetingCsv((values ?? []).join(','))
}

/** True when every value is a known section slug. */
export function isValidSectionSelection(values: readonly string[]): boolean {
  const list = parseTargetingCsv((values ?? []).join(','))
  return list.every((v) => (POST_SECTIONS as readonly string[]).includes(v))
}

/** True when every value is a known locale code. */
export function isValidLocaleSelection(values: readonly string[]): boolean {
  const list = parseTargetingCsv((values ?? []).join(','))
  return list.every((v) => (AD_LOCALE_CODES as readonly string[]).includes(v))
}

// ---------------------------------------------------------------------------
// Match — does a campaign include the page being served?
// ---------------------------------------------------------------------------

export interface AdRequestContext {
  /** Slug of the section being viewed ("intern-junior", …) or "home". */
  section?: string
  /** Active interface locale ("en", "ru", …). */
  locale?: string
  /**
   * Visitor country as ISO 3166-1 alpha-2 (lowercase ok). From the
   * CF-IPCountry header (set by Cloudflare) or the ?country= parameter.
   * undefined = unknown — only country-unrestricted campaigns match.
   */
  country?: string
  /**
   * Keyword context of the page (post title + tags on article pages).
   * Empty/undefined = no keyword context.
   */
  keywords?: string[]
  /** Hashtags of the page being served (post tags). */
  hashtags?: string[]
  /**
   * Phase 3 event pipeline: visitor User-Agent + best-effort IP. Not used
   * for targeting — they feed the AdEvent anti-fraud/analytics columns on
   * the loaded_impression row written at serve time (the bot filter itself
   * runs earlier, in the serve route, so bots never even reach the auction).
   */
  userAgent?: string
  visitorIp?: string
  /**
   * Phase 4 A/B testing: the STABLE server-minted visitor id
   * (antifraud.visitorStableId — salted HMAC of IP + User-Agent). Not used
   * for targeting — after a campaign with a RUNNING experiment wins the
   * draw, this id decides (via a stable hash) which variant the visitor
   * sees, so the same user always lands in the same arm.
   */
  visitorId?: string
}

/** The targeting slice of a Campaign row, as the auction reads it. */
export interface CampaignTargeting {
  targetSections: string
  targetLocales: string
  targetKeywords: string
  keywordMatch: string
  countryMode: string
  targetCountries: string
  targetHashtags: string
}

/**
 * Does a campaign's targeting include the page being served?
 *
 * Rules (symmetric across the dimensions):
 *   • campaign targeting empty  → matches anything (default "everywhere")
 *   • context value missing     → only campaigns WITHOUT that restriction
 *                                 match (a restricted campaign never buys
 *                                 unknown inventory)
 *   • otherwise                 → dimension-specific match:
 *       sections/locales  context value ∈ list
 *       keywords          phrase mode: a keyword is a substring of the
 *                         page's keyword text (joined with spaces);
 *                         exact mode: a keyword EQUALS one context phrase
 *       hashtags          any campaign hashtag ∈ page hashtags (exact)
 *       countries         include: visitor ∈ list; exclude: visitor ∉ list
 */
export function targetingMatches(camp: CampaignTargeting, ctx: AdRequestContext): boolean {
  // ---- sections -----------------------------------------------------------
  if (ctx.section !== undefined) {
    const sections = parseTargetingCsv(camp.targetSections)
    if (sections.length > 0 && !sections.includes(ctx.section)) return false
  }

  // ---- interface locale ----------------------------------------------------
  if (ctx.locale !== undefined) {
    const locales = parseTargetingCsv(camp.targetLocales)
    if (locales.length > 0 && !locales.includes(ctx.locale)) return false
  }

  // ---- contextual keywords -------------------------------------------------
  const keywords = parseTargetingCsv(camp.targetKeywords)
  if (keywords.length > 0) {
    if (!ctx.keywords || ctx.keywords.length === 0) return false // unknown inventory
    const phrases = ctx.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean)
    if (phrases.length === 0) return false
    if (camp.keywordMatch === 'exact') {
      const exact = new Set(phrases)
      if (!keywords.some((k) => exact.has(k))) return false
    } else {
      // phrase mode: substring of the page's keyword text
      const haystack = ` ${phrases.join(' ')} `
      if (!keywords.some((k) => haystack.includes(k))) return false
    }
  }

  // ---- hashtags (exact tags) ------------------------------------------------
  const hashtags = parseTargetingCsv(camp.targetHashtags)
  if (hashtags.length > 0) {
    if (!ctx.hashtags || ctx.hashtags.length === 0) return false // unknown inventory
    const pageTags = new Set(ctx.hashtags.map((h) => h.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-')).filter(Boolean))
    if (pageTags.size === 0) return false
    if (!hashtags.some((h) => pageTags.has(h))) return false
  }

  // ---- visitor country -------------------------------------------------------
  const mode = camp.countryMode === 'include' || camp.countryMode === 'exclude' ? camp.countryMode : 'all'
  if (mode !== 'all') {
    // parseTargetingCsv lower-cases: stored codes are lowercase ISO codes.
    const countries = parseTargetingCsv(camp.targetCountries)
    if (countries.length > 0) {
      if (!ctx.country) return false // unknown country — never buys restricted inventory
      const visitor = ctx.country.trim().toLowerCase()
      const inList = countries.includes(visitor)
      if (mode === 'include' && !inList) return false
      if (mode === 'exclude' && inList) return false
    }
  }

  return true
}

/** Human label for a section slug ("intern-junior" → "Intern/Junior"). */
export function sectionLabel(slug: string): string {
  const known = POST_SECTIONS.find((s: PostSection) => s === slug)
  return known ? SECTION_META[known].title : slug
}
