/**
 * UI-i18n dictionary injector — one-shot codegen for the global UI strings.
 *
 * What it does to every src/i18n/messages/<locale>.ts (all 20 locales):
 *   1. appends the new namespaces (hero, quickLinks, sections, postMeta,
 *      postList, support, save, article, about) from the typed payloads in
 *      this directory — TypeScript's `Messages` type then forces every
 *      locale to stay key-complete;
 *   2. injects additions into EXISTING namespaces (common.breadcrumb,
 *      search.title, search.pageSub);
 *   3. reverts the six section-name nav keys (nav.internJunior, …) to the
 *      ENGLISH strings in every locale — section names are functional
 *      identifiers (search, filtering, routing) and must not be translated;
 *   4. is IDEMPOTENT: a file that already carries `hero: {` is skipped.
 *
 * Run:  bun scripts/ui18n-codegen/inject.ts
 * Then: bunx tsc --noEmit   (proves all 20 dictionaries are key-complete)
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { en } from './en'
import { ru, uk } from './ru-uk'
import { es, pt } from './es-pt'
import { fr, de } from './fr-de'
import { hi } from './hi'
import { zh } from './zh'
import { fa } from './fa'
import { ar } from './ar'
import { bn } from './bn'
import { ko } from './ko'
import { ja } from './ja'
import { id } from './id'
import { fil } from './fil'
import { th } from './th'
import { vi } from './vi'
import { tr } from './tr'
import { ur } from './ur'
import type { LocalePayload } from './types'

const PAYLOADS: Record<string, LocalePayload> = {
  en, ru, uk, hi, zh, fa, ar, bn, es, pt, fr, de, ko, ja, id, fil, th, vi, tr, ur,
}

const MESSAGES_DIR = join(import.meta.dir, '..', '..', 'src', 'i18n', 'messages')

/** Section names — functional identifiers, ENGLISH in every locale. */
const ENGLISH_NAV: Record<string, string> = {
  internJunior: 'Intern/Junior',
  midSenior: 'Mid/Senior',
  opportunities: 'Opportunities',
  markets: 'Markets',
  insights: 'Insights',
  blog: 'Blog',
}

const NAV_NOTE = [
  '  // Section names stay ENGLISH in every locale — they are functional',
  '  // identifiers (search, filtering and routing depend on them).',
  '  // Only nav.about is translated. Do not "fix" this.',
]

// ---------------------------------------------------------------------------
// TS literal serialization
// ---------------------------------------------------------------------------

function tsStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function serializeNamespace(name: string, obj: Record<string, string>): string {
  const lines = [`  ${name}: {`]
  for (const [k, v] of Object.entries(obj)) {
    lines.push(`    ${k}: ${tsStr(v)},`)
  }
  lines.push('  },')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Per-file surgery
// ---------------------------------------------------------------------------

function injectLocale(locale: string, payload: LocalePayload): void {
  const file = join(MESSAGES_DIR, `${locale}.ts`)
  let src = readFileSync(file, 'utf8')
  if (src.includes('hero: {')) {
    console.log(`[inject] ${locale}: already carries the UI namespaces — skipped`)
    return
  }

  // 1) nav section-name revert (English in every locale, with a policy note).
  let navReverted = 0
  for (const [key, value] of Object.entries(ENGLISH_NAV)) {
    const re = new RegExp(`(\\n\\s*${key}:\\s*)'[^']*'`)
    if (re.test(src)) {
      src = src.replace(re, `$1${tsStr(value)}`)
      navReverted++
    }
  }
  if (locale !== 'en' && navReverted !== 6) {
    throw new Error(`${locale}: expected to revert 6 nav keys, reverted ${navReverted}`)
  }
  // Policy comment above the nav block (once).
  src = src.replace(/(\n)(  nav: \{)/, `$1${NAV_NOTE.join('\n')}\n$2`)

  // 2) additions to existing namespaces.
  const commonBlock = src.match(/\n(  common: \{\n)/)
  if (!commonBlock) throw new Error(`${locale}: common block not found`)
  src = src.replace(
    /\n(  common: \{\n)/,
    `$1    breadcrumb: ${tsStr(payload.existing.common.breadcrumb)},\n`,
  )

  const searchBlock = src.match(/\n(  search: \{\n)/)
  if (!searchBlock) throw new Error(`${locale}: search block not found`)
  src = src.replace(
    /\n(  search: \{\n)/,
    `$1    title: ${tsStr(payload.existing.search.title)},\n` +
      `    pageSub: ${tsStr(payload.existing.search.pageSub)},\n`,
  )

  // 3) append the new namespaces before the closing brace of the const.
  const exportIdx = src.indexOf('\nexport default')
  if (exportIdx < 0) throw new Error(`${locale}: "export default" not found`)
  const closingBrace = src.lastIndexOf('}', exportIdx)
  if (closingBrace < 0) throw new Error(`${locale}: closing brace not found`)

  const namespaces = Object.entries(
    payload.newNamespaces as unknown as Record<string, Record<string, string>>,
  )
    .map(([name, obj]) => serializeNamespace(name, obj))
    .join('\n')

  src =
    src.slice(0, closingBrace) +
    (namespaces + '\n') +
    src.slice(closingBrace)

  writeFileSync(file, src)
  console.log(
    `[inject] ${locale}: +${namespaces.split('\n').length} lines, nav reverted (${navReverted}/6), common/search additions in`,
  )
}

// ---------------------------------------------------------------------------

for (const [locale, payload] of Object.entries(PAYLOADS)) {
  injectLocale(locale, payload)
}
console.log('[inject] done — run `bunx tsc --noEmit` to verify key-completeness')
