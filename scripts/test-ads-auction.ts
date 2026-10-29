/**
 * Weighted-random auction — unit tests (pure, no server, no DB).
 *
 * Run: bun scripts/test-ads-auction.ts
 */
import { pickWeightedRandom } from '../src/lib/ads/auction'

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

console.log('— 1. edge cases —')
check(pickWeightedRandom([], 0.5) === null, 'no candidates → null')
check(pickWeightedRandom([{ id: 'a', bidPerView: 0 }], 0.5) === null, 'all-zero weights → null')

console.log('— 2. deterministic point mapping (roulette wheel) —')
const two = [
  { id: 'cheap', bidPerView: 1 },
  { id: 'pricey', bidPerView: 2 },
]
// total weight 3: point 0..1 → cheap, 1..3 → pricey
check(pickWeightedRandom(two, 0)?.id === 'cheap', 'point 0.0 → cheap (weight 1)')
check(pickWeightedRandom(two, 0.2)?.id === 'cheap', 'point 0.2 → cheap (inside its band)')
check(pickWeightedRandom(two, 0.32)?.id === 'cheap', 'point 0.32 → cheap (end of its band, 1/3)')
check(pickWeightedRandom(two, 0.34)?.id === 'pricey', 'point 0.34 → pricey (band starts at 1/3)')
check(pickWeightedRandom(two, 0.99)?.id === 'pricey', 'point 0.99 → pricey')

console.log('— 3. proportional selection (2:1 bid → ~2:1 picks) —')
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
check(
  ratio > 1.85 && ratio < 2.15,
  `ratio ${ratio.toFixed(3)} ≈ 2.0 (pricey ${priceyWins} vs cheap ${cheapWins} of ${N})`,
)

console.log('— 4. single candidate always wins —')
const solo = [{ id: 'only', bidPerView: 5 }]
let soloWins = 0
for (let i = 0; i < 500; i++) {
  if (pickWeightedRandom(solo, i / 500)?.id === 'only') soloWins++
}
check(soloWins === 500, `single candidate picked 500/500 (got ${soloWins})`)

console.log('— 5. three-way bands —')
const three = [
  { id: 'a', bidPerView: 1 },
  { id: 'b', bidPerView: 1 },
  { id: 'c', bidPerView: 2 },
]
// bands: a [0,1), b [1,2), c [2,4)
check(pickWeightedRandom(three, 0.2)?.id === 'a', 'point 0.2 → a')
check(pickWeightedRandom(three, 0.4)?.id === 'b', 'point 0.4 → b')
check(pickWeightedRandom(three, 0.9)?.id === 'c', 'point 0.9 → c')

console.log('— 6. negative/zero bid never wins a mixed wheel —')
const mixed = [
  { id: 'zero', bidPerView: 0 },
  { id: 'one', bidPerView: 1 },
]
let zeroWins = 0
for (let i = 0; i < 1000; i++) {
  if (pickWeightedRandom(mixed, i / 1000)?.id === 'zero') zeroWins++
}
check(zeroWins === 0, `zero-weight candidate never picked (${zeroWins} wins)`)

console.log('')
if (fail > 0) {
  console.log(`FAILED: ${fail} check(s) failed (${pass} passed)`)
  process.exit(1)
}
console.log(`ALL PASS — ${pass} checks`)
