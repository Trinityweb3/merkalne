/**
 * Injects the three BlockBee top-up keys into the EXISTING `ads:` namespace
 * of every dictionary that lacks them (all 20 locales). Idempotent — keys
 * already present are left untouched.
 *
 * Run: bun scripts/ui18n-codegen/inject-blockbee.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOCKBEE_ADS_KEYS } from './blockbee-payloads'

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
  const payload = BLOCKBEE_ADS_KEYS[locale]
  if (!payload) throw new Error(`${locale}: no BlockBee payload found`)

  const lines: string[] = []
  let injected = 0
  for (const [key, value] of Object.entries(payload)) {
    const keyPattern = new RegExp(`(^|\\n\\s+)${key}:\\s*['\`]`)
    if (keyPattern.test(src)) continue // already present
    lines.push(`    ${key}: '${escapeValue(value)}',`)
    injected++
  }
  if (lines.length === 0) {
    console.log(`[inject-blockbee] ${locale}: nothing to do`)
    continue
  }

  // Insert right after the `ads: {` opener (present in every dictionary
  // since the ads-namespace injection).
  const adsIdx = src.indexOf('ads: {')
  if (adsIdx < 0) throw new Error(`${locale}: "ads: {" namespace not found`)
  const insertAt = src.indexOf('\n', adsIdx) + 1
  src = src.slice(0, insertAt) + lines.join('\n') + '\n' + src.slice(insertAt)
  writeFileSync(file, src)
  console.log(`[inject-blockbee] ${locale}: injected ${injected} key(s)`)
}
console.log('[inject-blockbee] done — run check-messages.ts + tsc to verify')
