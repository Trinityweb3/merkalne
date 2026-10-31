/**
 * Phase-1 auction + money rules — unit tests (pure, no server, no DB).
 *
 * Run: bun scripts/test-ads-auction.ts
 */
import {
  pickWeightedRandom,
  pickPoolAndDraw,
  type PoolCandidate,
} from '../src/lib/ads/auction'
import {
  BID_BOUNDS,
  centsToMicro,
  cpmPerViewMicro,
  formatMicroUsd,
  microToCents,
  minTotalBudgetCents,
  perEventCents,
  budgetEventEstimate,
  type BillingModel,
} from '../src/lib/ads/money'

let pass = 0
let fail = 0

function check(ok: boolean, label: string): void {
  if (ok) {
    pass++
    console.log(`  [ok]   ${label}`)
  } else {
    fail++
    console.log(`  [FAIL] ${label}`)
  }
}

console.log('— 1. weighted draw: edge cases —')
check(pickWeightedRandom([], 0.5) === null, 'no candidates → null')
check(pickWeightedRandom([{ id: 'a', bidMicroUsd: 0 }], 0.5) === null, 'all-zero weights → null')

console.log('— 2. weighted draw: deterministic point mapping (roulette wheel) —')
const two = [
  { id: 'cheap', bidMicroUsd: 1_000_000 },
  { id: 'pricey', bidMicroUsd: 2_000_000 },
]
// total weight 3M: point 0..1/3 → cheap, 1/3..1 → pricey
check(pickWeightedRandom(two, 0)?.id === 'cheap', 'point 0.0 → cheap (weight 1M)')
check(pickWeightedRandom(two, 0.2)?.id === 'cheap', 'point 0.2 → cheap (inside its band)')
check(pickWeightedRandom(two, 0.32)?.id === 'cheap', 'point 0.32 → cheap (end of its band, 1/3)')
check(pickWeightedRandom(two, 0.34)?.id === 'pricey', 'point 0.34 → pricey (band starts at 1/3)')
check(pickWeightedRandom(two, 0.99)?.id === 'pricey', 'point 0.99 → pricey')

console.log('— 3. weighted draw: proportional selection (2:1 bid → ~2:1 picks) —')
let priceyWins = 0
let cheapWins = 0
const N = 30_000
for (let i = 0; i < N; i++) {
  const pick = pickWeightedRandom(two)
  if (!pick) throw new Error('unexpected null pick')
  if (pick.id === 'pricey') priceyWins++
  else cheapWins++
}
const ratio = priceyWins / cheapWins
check(ratio > 1.85 && ratio < 2.15, `ratio ${ratio.toFixed(3)} ≈ 2.0 (pricey ${priceyWins} vs cheap ${cheapWins} of ${N})`)

console.log('— 4. pool split: 50/50 when both pools exist —')
const pools: PoolCandidate[] = [
  { id: 'cpc-a', bidMicroUsd: 500_000, billingModel: 'cpc' },
  { id: 'cpm-b', bidMicroUsd: 500_000, billingModel: 'cpm' },
]
let cpcPicks = 0
let cpmPicks = 0
const M = 20_000
for (let i = 0; i < M; i++) {
  const pick = pickPoolAndDraw(pools)
  if (!pick) throw new Error('unexpected null pick')
  if (pick.billingModel === 'cpc') cpcPicks++
  else cpmPicks++
}
check(
  Math.abs(cpcPicks - M / 2) < M * 0.02 && Math.abs(cpmPicks - M / 2) < M * 0.02,
  `pool split ~50/50 (cpc ${cpcPicks} vs cpm ${cpmPicks} of ${M})`,
)
// Deterministic mapping: first half of the unit interval → CPC, second → CPM.
check(pickPoolAndDraw(pools, 0.1)?.id === 'cpc-a', 'point 0.1 → cpc pool (first half)')
check(pickPoolAndDraw(pools, 0.1)?.id === 'cpc-a', 'point 0.1 (re-run) → same (pure function)')
check(pickPoolAndDraw(pools, 0.6)?.id === 'cpm-b', 'point 0.6 → cpm pool (second half)')

console.log('— 5. pool split: single non-empty pool uses the point directly —')
const onlyCpc: PoolCandidate[] = [
  { id: 'cpc-a', bidMicroUsd: 1_000_000, billingModel: 'cpc' },
  { id: 'cpc-b', bidMicroUsd: 3_000_000, billingModel: 'cpc' },
]
// weights 1:3 → bands 0..0.25, 0.25..1
check(pickPoolAndDraw(onlyCpc, 0.1)?.id === 'cpc-a', 'cpc-only pool: point 0.1 → cpc-a (band 0–0.25)')
check(pickPoolAndDraw(onlyCpc, 0.5)?.id === 'cpc-b', 'cpc-only pool: point 0.5 → cpc-b')
const onlyCpm: PoolCandidate[] = [{ id: 'cpm-x', bidMicroUsd: 1_000_000, billingModel: 'cpm' }]
check(pickPoolAndDraw(onlyCpm, 0.5)?.id === 'cpm-x', 'cpm-only pool → cpm-x')
check(pickPoolAndDraw([], 0.5) === null, 'empty candidate set → null')
check(pickPoolAndDraw([{ id: 'z', bidMicroUsd: 0, billingModel: 'cpc' }], 0.5) === null, 'zero-weight pool → null')

console.log('— 6. micro-USD money rules —')
check(centsToMicro(500) === 5_000_000, '500¢ → 5,000,000 µUSD')
check(microToCents(5_000_000) === 500, '5,000,000 µUSD → 500¢')
check(cpmPerViewMicro(2_000_000) === 2_000, '$2.00 CPM → 2,000 µUSD ($0.002) per view')
check(cpmPerViewMicro(500_000) === 500, '$0.50 CPM → 500 µUSD per view')
check(cpmPerViewMicro(123_456_789) === 123_456, 'fractional micro defence: floor(123456789/1000)')
check(formatMicroUsd(5_000_000) === '$5.00', 'format 5,000,000 → $5.00')
check(formatMicroUsd(199_999) === '$0.20', 'format 199,999 µ → $0.20 (sub-cent rounds to nearest cent)')
check(formatMicroUsd(-500_000) === '-$0.50', 'format negative → -$0.50')
check(BID_BOUNDS.cpc.minCents === 5 && BID_BOUNDS.cpc.maxCents === 500, 'CPC bid bounds $0.05–$5.00')
check(BID_BOUNDS.cpm.minCents === 10 && BID_BOUNDS.cpm.maxCents === 5_000, 'CPM bid bounds $0.10–$50.00')

console.log('— 7. per-event cost & minimum flight rules —')
const cpc: BillingModel = 'cpc'
const cpm: BillingModel = 'cpm'
check(perEventCents(cpc, 50) === 50, 'CPC event cost = the bid (50¢)')
check(perEventCents(cpm, 200) === 1, 'CPM event cost = bid/1000 ($2.00 → 0.2¢ → ceil 1¢)')
check(perEventCents(cpm, 199) === 1, 'CPM event cost rounds up ($1.99 → 0.199¢ → 1¢)')
check(
  minTotalBudgetCents(cpc, 50) === 1_000,
  'CPC min budget at $0.50/click = $10 (20 events)',
)
check(
  minTotalBudgetCents(cpc, 5) === 100,
  'CPC min budget at $0.05/click = $1 floor (20×5¢ = $1)',
)
check(
  minTotalBudgetCents(cpm, 200) === 100,
  'CPM min budget at $2.00 CPM = $1 floor (20 views = $0.04)',
)
check(
  minTotalBudgetCents(cpm, 5_000) === 100,
  'CPM min budget at $50 CPM = $1 floor (20 views = $1 exactly)',
)
check(budgetEventEstimate(cpc, 1_000, 50) === 20, '$10 at $0.50/click ≈ 20 clicks')
check(budgetEventEstimate(cpm, 1_000, 200) === 5_000, '$10 at $2.00 CPM ≈ 5000 views')
check(budgetEventEstimate(cpm, 1_000, 0) === 0, 'zero bid → zero estimate (never divides by zero)')

console.log('— 8. Phase 2 targeting: keywords / hashtags / countries —')
import {
  parseCountryInput,
  parseHashtagInput,
  parseKeywordInput,
  targetingMatches,
  type CampaignTargeting,
} from '../src/lib/ads/targeting'

/** Convenience factory: everything unrestricted by default. */
function camp(over: Partial<CampaignTargeting> = {}): CampaignTargeting {
  return {
    targetSections: '',
    targetLocales: '',
    targetKeywords: '',
    keywordMatch: 'phrase',
    countryMode: 'all',
    targetCountries: '',
    targetHashtags: '',
    ...over,
  }
}

// unrestricted campaign matches anything, including context-less requests
check(targetingMatches(camp(), {}) === true, 'no restrictions → matches a context-less request')
check(targetingMatches(camp(), { section: 'markets', locale: 'ru', country: 'DE', keywords: ['bitcoin'], hashtags: ['crypto'] }) === true, 'no restrictions → matches a rich context')

// sections & locales (Phase 1 rules unchanged)
check(targetingMatches(camp({ targetSections: 'markets' }), { section: 'markets' }) === true, 'section match')
check(targetingMatches(camp({ targetSections: 'markets' }), { section: 'blog' }) === false, 'section mismatch')
check(targetingMatches(camp({ targetSections: 'markets' }), {}) === true, 'section restriction ignored when the page carries no section')

// keywords — phrase mode
check(
  targetingMatches(camp({ targetKeywords: 'smart contracts' }), { keywords: ['Ethereum Smart Contracts 101', 'web3'] }) === true,
  'phrase keyword: substring of a context phrase (case-insensitive)',
)
check(
  targetingMatches(camp({ targetKeywords: 'solidity' }), { keywords: ['remote solidity jobs', 'junior'] }) === true,
  'phrase keyword: substring across the joined context',
)
check(
  targetingMatches(camp({ targetKeywords: 'rust' }), { keywords: ['remote solidity jobs'] }) === false,
  'phrase keyword: no substring → no match',
)
// keywords — exact mode
check(
  targetingMatches(camp({ targetKeywords: 'solidity', keywordMatch: 'exact' }), { keywords: ['Solidity', 'junior'] }) === true,
  'exact keyword: equals a context phrase (case-insensitive)',
)
check(
  targetingMatches(camp({ targetKeywords: 'solidity jobs', keywordMatch: 'exact' }), { keywords: ['remote solidity jobs'] }) === false,
  'exact keyword: substring of a phrase is NOT an exact match',
)
// unknown-inventory rule
check(
  targetingMatches(camp({ targetKeywords: 'solidity' }), {}) === false,
  'keyword-targeted campaign never buys pages without keyword context',
)
check(
  targetingMatches(camp({ targetKeywords: 'solidity' }), { keywords: [] }) === false,
  'keyword-targeted campaign ignores empty keyword lists',
)

// hashtags — exact tags
check(targetingMatches(camp({ targetHashtags: 'web3' }), { hashtags: ['Web3', 'jobs'] }) === true, 'hashtag match (case-insensitive, exact)')
check(targetingMatches(camp({ targetHashtags: 'web3' }), { hashtags: ['web3jobs'] }) === false, 'hashtag must be exact, not a substring')
check(targetingMatches(camp({ targetHashtags: 'web3,jobs' }), { hashtags: ['jobs'] }) === true, 'multiple campaign hashtags are OR-ed')
check(targetingMatches(camp({ targetHashtags: 'web3' }), {}) === false, 'hashtag campaign never buys pages without tags')

// countries — include / exclude / all
check(targetingMatches(camp({ countryMode: 'include', targetCountries: 'de,us' }), { country: 'de' }) === true, 'include: listed country matches')
check(targetingMatches(camp({ countryMode: 'include', targetCountries: 'de,us' }), { country: 'FR' }) === false, 'include: unlisted country does not match')
check(targetingMatches(camp({ countryMode: 'exclude', targetCountries: 'de,us' }), { country: 'fr' }) === true, 'exclude: unlisted country matches')
check(targetingMatches(camp({ countryMode: 'exclude', targetCountries: 'de,us' }), { country: 'US' }) === false, 'exclude: listed country does not match')
check(targetingMatches(camp({ countryMode: 'include', targetCountries: 'de' }), {}) === false, 'restricted campaign never buys unknown-country traffic')
check(targetingMatches(camp({ countryMode: 'include', targetCountries: '' }), { country: 'fr' }) === true, 'include mode with an empty list = no restriction')
check(targetingMatches(camp({ countryMode: 'weird', targetCountries: 'de' }), { country: 'fr' }) === true, 'unknown mode falls back to "all" (defence in depth)')

// input parsers
check(
  JSON.stringify(parseKeywordInput(['Solidity', '  remote   junior ', 'solidity', '', 'x'.repeat(80)])) === JSON.stringify(['solidity', 'remote junior']),
  'parseKeywordInput: trims, lowercases, dedupes, caps length; overlong phrases dropped',
)
check(
  JSON.stringify(parseHashtagInput(['#Web3', 'Jobs', 'web3'])) === JSON.stringify(['web3', 'jobs']),
  'parseHashtagInput: strips leading #, lowercases, dedupes',
)
check(
  JSON.stringify(parseCountryInput(['de', ' US ', 'deu', 'DE'])) === JSON.stringify(['DE', 'US']),
  'parseCountryInput: uppercases valid ISO alpha-2, drops 3+ letter garbage + dupes',
)

console.log('')
if (fail > 0) {
  console.log(`FAILED: ${fail} check(s) failed (${pass} passed)`)
  process.exit(1)
}
console.log(`ALL PASS — ${pass} checks`)
