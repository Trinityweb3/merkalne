/**
 * Merklane Ads — money units & validation bounds.
 *
 * RULE (Phase 1 spec): NEVER use JavaScript floats for money. Every money
 * value in the ads system is an INTEGER in micro-USD:
 *
 *   $1.00  = 1_000_000 µUSD        (MICRO_PER_USD)
 *   $0.01  =    10_000 µUSD        (MICRO_PER_CENT)
 *
 * The BlockBee/top-up domain keeps its long-standing US-cent integers
 * (CryptoTopUp.amountExpected/Received, referral commissions) — cents are
 * converted to micro-USD exactly once, at the wallet boundary
 * (centsToMicro), and never back.
 *
 * This module is PURE (no database, no server-only imports) so the client
 * components can format with the exact same code as the API layer.
 */

/** 1 US cent in micro-USD. */
export const MICRO_PER_CENT = 10_000
/** 1 US dollar in micro-USD. */
export const MICRO_PER_USD = 1_000_000
/** CPM bids are per this many views. */
export const CPM_VIEWS = 1000

export function centsToMicro(cents: number): number {
  return Math.round(cents) * MICRO_PER_CENT
}

export function microToCents(microUsd: number): number {
  return Math.round(microUsd / MICRO_PER_CENT)
}

/**
 * CPM cost of a single view: bidMicroUsd / 1000. Whole-cent bids always
 * divide cleanly (cents × 10 is a multiple of 1000); the floor is defence
 * in depth against non-cent-aligned data ever entering the table.
 */
export function cpmPerViewMicro(bidMicroUsd: number): number {
  return Math.floor(bidMicroUsd / CPM_VIEWS)
}

/** "$1.23" — display rounding to the nearest cent (CPM per-view charges are sub-cent). */
export function formatMicroUsd(microUsd: number): string {
  const cents = microToCents(microUsd)
  const negative = cents < 0
  const abs = Math.abs(cents)
  return `${negative ? '-' : ''}$${(abs / 100).toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Validation bounds — whole US cents (identical semantics for the API layer
// and the client-side form pre-checks)
// ---------------------------------------------------------------------------

export const BID_BOUNDS = {
  /** Per click. */
  cpc: { minCents: 5, maxCents: 500 }, // $0.05 – $5.00
  /** Per 1000 views. */
  cpm: { minCents: 10, maxCents: 5_000 }, // $0.10 – $50.00
} as const

export type BillingModel = 'cpc' | 'cpm'
export type AdFormat = 'text' | 'banner'

export const TOTAL_BUDGET_BOUNDS = { minCents: 100, maxCents: 5_000_000 } as const // $1 – $50,000
export const DAILY_BUDGET_BOUNDS = { minCents: 100, maxCents: 5_000_000 } as const // $1 – $50,000 (0 = no cap)

/** A new campaign must be able to buy at least this many billable events. */
export const MIN_BUDGET_EVENTS = 20

/** Price of one billable event, in cents, for the given model (integer division for CPM is exact at whole cents). */
export function perEventCents(model: BillingModel, bidCents: number): number {
  return model === 'cpc' ? bidCents : Math.ceil(bidCents / CPM_VIEWS)
}

/** Price of one billable event in micro-USD. */
export function perEventMicroUsd(model: BillingModel, bidMicroUsd: number): number {
  return model === 'cpc' ? bidMicroUsd : cpmPerViewMicro(bidMicroUsd)
}

/**
 * Minimum total budget for a campaign: at least $1.00 AND enough for
 * MIN_BUDGET_EVENTS billable events at the bid.
 */
export function minTotalBudgetCents(model: BillingModel, bidCents: number): number {
  return Math.max(TOTAL_BUDGET_BOUNDS.minCents, perEventCents(model, bidCents) * MIN_BUDGET_EVENTS)
}

/**
 * Number of billable events a budget buys (for "≈ N clicks/views" hints).
 * Uses the EXACT per-event price (not the ceiled perEventCents) so CPM
 * estimates are honest: $10 at $2.00 CPM really is 5000 views.
 */
export function budgetEventEstimate(model: BillingModel, budgetCents: number, bidCents: number): number {
  if (bidCents <= 0) return 0
  if (model === 'cpc') return Math.floor(budgetCents / bidCents)
  return Math.floor((budgetCents * 1000) / bidCents)
}
