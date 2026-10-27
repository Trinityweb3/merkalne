/**
 * ICU message-format compile check for every dictionary entry (all 20
 * locales). next-intl compiles messages lazily — a malformed plural rule
 * would only blow up when a page renders. This walks EVERY message and
 * compiles it with IntlMessageFormat, so syntax errors surface here.
 *
 * Run: bun scripts/ui18n-codegen/check-messages.ts
 */
import { createRequire } from 'node:module'
import en from '../../src/i18n/messages/en'
import ru from '../../src/i18n/messages/ru'
import uk from '../../src/i18n/messages/uk'
import hi from '../../src/i18n/messages/hi'
import zh from '../../src/i18n/messages/zh'
import fa from '../../src/i18n/messages/fa'
import ar from '../../src/i18n/messages/ar'
import bn from '../../src/i18n/messages/bn'
import es from '../../src/i18n/messages/es'
import pt from '../../src/i18n/messages/pt'
import fr from '../../src/i18n/messages/fr'
import de from '../../src/i18n/messages/de'
import ko from '../../src/i18n/messages/ko'
import ja from '../../src/i18n/messages/ja'
import id from '../../src/i18n/messages/id'
import fil from '../../src/i18n/messages/fil'
import th from '../../src/i18n/messages/th'
import vi from '../../src/i18n/messages/vi'
import tr from '../../src/i18n/messages/tr'
import ur from '../../src/i18n/messages/ur'

const require = createRequire(import.meta.url)
const { IntlMessageFormat } = require('intl-messageformat')

const DICTS: Record<string, unknown> = {
  en, ru, uk, hi, zh, fa, ar, bn, es, pt, fr, de, ko, ja, id, fil, th, vi, tr, ur,
}

let total = 0
let failures = 0

function walk(node: unknown, path: string, locale: string): void {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, locale)
    }
    return
  }
  if (typeof node !== 'string') return
  total++
  try {
    // Rich-text tags (<section>…</section>) are handled by next-intl, not the
    // raw ICU parser — strip tag-looking segments before compiling.
    const cleaned = node.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g, 'x')
    new IntlMessageFormat(cleaned, locale)
  } catch (err) {
    failures++
    console.error(`[check] ${locale} · ${path}: ${String(err)}`)
    console.error(`         message: ${node.slice(0, 160)}`)
  }
}

for (const [locale, dict] of Object.entries(DICTS)) {
  walk(dict, '', locale)
}

console.log(`[check] compiled ${total} messages across ${Object.keys(DICTS).length} locales — ${failures} failure(s)`)
process.exit(failures > 0 ? 1 : 0)
