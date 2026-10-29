/**
 * One-off migration script: inserts the new `premium` namespace (pricing,
 * plans, checkout, FAQ) plus `header.premiumActive` into every locale
 * dictionary. Fails loudly when an anchor is missing so a partial run can
 * never silently produce a broken dictionary.
 *
 * Usage: node scripts/add-premium-i18n-keys.mjs   (or: bun scripts/add-premium-i18n-keys.mjs)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { G1 } from './premium-i18n-g1.mjs'
import { G2 } from './premium-i18n-g2.mjs'
import { G3 } from './premium-i18n-g3.mjs'
import { G4 } from './premium-i18n-g4.mjs'

const T = { ...G1, ...G2, ...G3, ...G4 }

function tsEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// Key order = the shape every locale must share (Messages type).
const KEY_ORDER = [
  'metaTitle', 'metaDescription',
  'heroEyebrow', 'heroTitle', 'heroSub',
  'monthly', 'yearly', 'save50', 'perMonth', 'perYear',
  'planFree', 'planPremium', 'planPremiumPlus',
  'taglineFree', 'taglinePremium', 'taglinePlus',
  'freeF1', 'freeF2', 'freeF3', 'freeF4', 'freeF5',
  'premF1', 'premF2', 'premF3', 'premF4',
  'plusF1', 'plusF2', 'plusF3', 'plusF4',
  'badgePopular',
  'ctaCurrent', 'ctaGetPremium', 'ctaGetPlus', 'ctaUpgrade', 'ctaExtend', 'createAccount',
  'statusActive', 'statusActivePlus', 'statusUntil', 'statusNeverExpires', 'manageAlerts',
  'blockbeeNote',
  'faqTitle', 'faqQ1', 'faqA1', 'faqQ2', 'faqA2', 'faqQ3', 'faqA3', 'faqQ4', 'faqA4',
  'checkoutTitle', 'checkoutSummary', 'checkoutCoin', 'checkoutCoinNote', 'checkoutPay',
  'checkoutAddress', 'checkoutCopy', 'checkoutAmount', 'checkoutPending',
  'checkoutConfirmed', 'checkoutConfirmedNote', 'checkoutSecurity', 'checkoutUnavailable',
  'errorGeneric',
]

let failed = false
for (const [locale, dict] of Object.entries(T)) {
  const path = `src/i18n/messages/${locale}.ts`
  let src = readFileSync(path, 'utf8')

  // Idempotency: skip locales that already carry the namespace.
  if (src.includes('\n  premium: {')) {
    console.log(`${locale}: already has the premium namespace — skipped`)
    continue
  }

  // 1) header.premiumActive — inserted right after the header namespace's
  //    `premium:` key (the FIRST occurrence in the file; the footer one
  //    comes later and is untouched).
  const headerRe = /(\n    premium: '[^']*?',)/
  if (!headerRe.test(src)) {
    console.error(`${locale}: header premium anchor not found — aborting this file`)
    failed = true
    continue
  }
  src = src.replace(
    headerRe,
    `$1\n    premiumActive: '${tsEscape(dict.header_premiumActive)}',`,
  )

  // 2) The whole `premium: { … }` namespace, inserted before the top-level
  //    closing brace (the one directly before `export default`).
  const tailIdx = src.indexOf('\n}\n\nexport default')
  if (tailIdx === -1) {
    console.error(`${locale}: top-level closing brace anchor not found — aborting this file`)
    failed = true
    continue
  }
  const lines = KEY_ORDER.map((k) => `    ${k}: '${tsEscape(dict[k])}',`).join('\n')
  const ns = `\n  premium: {\n${lines}\n  },`
  src = src.slice(0, tailIdx) + ns + src.slice(tailIdx)

  writeFileSync(path, src)
  console.log(`${locale}: ok`)
}

if (failed) {
  console.error('FAILED — check the errors above')
  process.exit(1)
}
console.log(`\nDone: ${Object.keys(T).length} locales processed.`)
