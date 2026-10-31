/**
 * Applies the Phase-1 ads dashboard i18n changes to every dictionary (all 20
 * locales), inside the EXISTING `ads:` namespace:
 *
 *   removes — delete the key line (concept gone with per-view billing)
 *   updates — remove + re-insert with the new value (injected at the top of
 *             the namespace; key order in JS objects is irrelevant)
 *   adds    — insert (idempotent: a key already present is left untouched —
 *             re-running the injector changes nothing)
 *
 * Run: bun scripts/ui18n-codegen/inject-ads-phase1.ts
 * Then: bun scripts/ui18n-codegen/check-messages.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADS_PHASE1 } from './ads-phase1-payloads'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MESSAGES_DIR = join(root, 'src/i18n/messages')

const LOCALES = [
  'en', 'ru', 'uk', 'hi', 'zh', 'fa', 'ar', 'bn', 'es', 'pt',
  'fr', 'de', 'ko', 'ja', 'id', 'fil', 'th', 'vi', 'tr', 'ur',
]

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

for (const locale of LOCALES) {
  const file = join(MESSAGES_DIR, `${locale}.ts`)
  let src = readFileSync(file, 'utf8')
  const payload = ADS_PHASE1[locale]
  if (!payload) throw new Error(`${locale}: no Phase-1 payload found`)

  const adsIdx = src.indexOf('ads: {')
  if (adsIdx < 0) throw new Error(`${locale}: "ads: {" namespace not found`)

  let removed = 0
  let updated = 0
  let added = 0

  // 1. Removals + update-old-lines: strip whole `key: '…',` lines. All the
  //    affected keys were injected by earlier single-line inserters, so they
  //    are single-line, single-quoted in every dictionary.
  for (const key of [...payload.removes, ...Object.keys(payload.updates)]) {
    const lineRe = new RegExp("^[ \\t]*" + key + ":[ \\t]*('[^\\n]*'|\"[^\\n]*\"),[ \\t]*\\n", 'm')
    if (lineRe.test(src)) {
      src = src.replace(lineRe, '')
      if (payload.removes.includes(key)) removed++
      else updated++
    } else if (!payload.removes.includes(key)) {
      // Update target missing → counted as a plain add below.
      updated--
    }
  }

  // 2. Inserts (updates + adds) right after the `ads: {` opener.
  const lines: string[] = []
  for (const [key, value] of Object.entries({ ...payload.updates, ...payload.adds })) {
    const keyPattern = new RegExp(`(^|\\n\\s+)${key}:\\s*['\`]`)
    if (keyPattern.test(src)) continue // already present (idempotent re-run)
    lines.push(`    ${key}: '${escapeValue(value)}',`)
    if (key in payload.updates) {
      if (updated < 0) updated++ // was missing entirely → fresh insert
    } else added++
  }
  if (lines.length > 0) {
    const insertAt = src.indexOf('\n', src.indexOf('ads: {')) + 1
    src = src.slice(0, insertAt) + lines.join('\n') + '\n' + src.slice(insertAt)
  }

  writeFileSync(file, src)
  console.log(
    `[inject-ads-phase1] ${locale}: +${added} added, ~${Math.max(updated, 0)} updated, -${removed} removed`,
  )
}
console.log('[inject-ads-phase1] done — run check-messages.ts + tsc to verify')
