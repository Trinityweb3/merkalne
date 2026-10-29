/**
 * One-shot i18n surgery for the Ads + CMS release:
 *   1. REMOVES about.translationVia / about.translationViaModel from every
 *      dictionary (the About-page translation indicator was removed).
 *   2. APPENDS the new `ads` (advertiser dashboard) and `adSlot` (sponsored
 *      card labels) namespaces to every dictionary.
 *
 * Translations live in scripts/ui18n-codegen/ads-payloads.ts (all 20
 * locales). Idempotent: a file already carrying `ads: {` is skipped for the
 * append, and the translationVia removal is a no-op when absent.
 *
 * Run:  bun scripts/ui18n-codegen/inject-ads.ts
 * Then: bun scripts/ui18n-codegen/check-messages.ts && bunx tsc --noEmit
 */
import { writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ADS_PAYLOADS } from './ads-payloads'

const MESSAGES_DIR = join(import.meta.dir, '..', '..', 'src', 'i18n', 'messages')

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

const locales = readdirSync(MESSAGES_DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'en.ts')
  .map((f) => f.replace('.ts', ''))
  .sort()
locales.unshift('en')

for (const locale of locales) {
  const file = join(MESSAGES_DIR, `${locale}.ts`)
  let src = readFileSync(file, 'utf8')

  // 1. Drop the translation-indicator keys (regex over the translated values).
  const before = src
  src = src.replace(/\n\s+translationVia:\s*'[^']*'\n/g, '\n')
  src = src.replace(/\n\s+translationViaModel:\s*'[^']*'\n/g, '\n')
  src = src.replace(/\n\s+translationVia:\s*'[^']*',\n/g, '\n')
  src = src.replace(/\n\s+translationViaModel:\s*'[^']*',\n/g, '\n')
  const removed = before !== src

  // 2. Append the new namespaces before the closing brace of the const.
  let appended = false
  if (!src.includes('ads: {')) {
    const payload = ADS_PAYLOADS[locale]
    if (!payload) throw new Error(`${locale}: no ads payload found`)
    const block =
      serializeNamespace('ads', payload.ads) + '\n' + serializeNamespace('adSlot', payload.adSlot)
    const exportIdx = src.indexOf('\nexport default')
    if (exportIdx < 0) throw new Error(`${locale}: "export default" not found`)
    const closingBrace = src.lastIndexOf('}', exportIdx)
    if (closingBrace < 0) throw new Error(`${locale}: closing brace not found`)
    src = src.slice(0, closingBrace) + block + '\n' + src.slice(closingBrace)
    appended = true
  }

  writeFileSync(file, src)
  console.log(`[inject-ads] ${locale}: removed=${removed} appended=${appended}`)
}
console.log('[inject-ads] done — run check-messages.ts + tsc to verify')
