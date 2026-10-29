/**
 * Merklane Ads — campaign targeting helpers.
 *
 * Targeting is stored as normalised comma-separated strings on AdCampaign
 * (portable CSV instead of scalar lists — see the modelling rules at the
 * top of prisma/schema.prisma):
 *
 *   targetSections  "intern-junior,mid-senior"   (POST_SECTIONS slugs)
 *   targetLocales   "en,ru"                      (interface locale codes)
 *
 * Empty string = no restriction: the campaign matches EVERY section /
 * every language. The auction engine (src/lib/ads/auction.ts) uses
 * `targetingMatches()` to drop campaigns that exclude the page currently
 * being served; the campaign API uses `sanitizeTargeting()` to validate
 * the advertiser's selection against the known slugs/locales.
 */
import { LANGUAGES, POST_SECTIONS, SECTION_META, type PostSection } from '@/lib/constants'

/** Section contexts the serve API accepts (content sections + the homepage). */
export const AD_SECTION_CONTEXTS: readonly string[] = [...POST_SECTIONS, 'home']

/** Every interface locale code (en, ru, …). */
export const AD_LOCALE_CODES: readonly string[] = LANGUAGES.map((l) => l.code)

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

export interface AdRequestContext {
  /** Slug of the section being viewed ("intern-junior", …) or "home". */
  section?: string
  /** Active interface locale ("en", "ru", …). */
  locale?: string
}

/**
 * Does a campaign's targeting include the page being served?
 *
 * Rules (symmetric for sections and locales):
 *   • campaign targeting empty  → matches anything (default "everywhere")
 *   • context value missing     → only campaigns WITHOUT that restriction
 *                                 match (a campaign that targets specific
 *                                 sections never buys unknown inventory)
 *   • otherwise                 → the context value must be in the list
 */
export function targetingMatches(
  targetSectionsCsv: string,
  targetLocalesCsv: string,
  ctx: AdRequestContext,
): boolean {
  if (ctx.section !== undefined) {
    const sections = parseTargetingCsv(targetSectionsCsv)
    if (sections.length > 0 && !sections.includes(ctx.section)) return false
  }
  if (ctx.locale !== undefined) {
    const locales = parseTargetingCsv(targetLocalesCsv)
    if (locales.length > 0 && !locales.includes(ctx.locale)) return false
  }
  return true
}

/** Human label for a section slug ("intern-junior" → "Intern/Junior"). */
export function sectionLabel(slug: string): string {
  const known = POST_SECTIONS.find((s: PostSection) => s === slug)
  return known ? SECTION_META[known].title : slug
}
