/**
 * Merklane Premium — the single source of truth for plans, prices and
 * entitlement checks. Used by the pricing UI, the checkout API, the BlockBee
 * webhook, the alert-dispatch worker and the Telegram bots so every surface
 * agrees on what "active Premium" means.
 *
 * Plans:
 *   free          reading, search, bookmarks, Blog publishing (forever)
 *   premium       $5.00/month · $30.00/year — job alerts (email + Telegram)
 *   premium_plus  $15.00/month · $90.00/year — alerts + editorial quotas
 *
 * Entitlement semantics (schema comment on User.premiumUntil): plan is one
 * of the two paid values AND premiumUntil is either NULL (= never expires,
 * operator grant) or in the future. Anything else is a free user — free
 * users NEVER receive job alerts (CRITICAL business rule).
 */

export type PremiumPlan = 'premium' | 'premium_plus'
export type BillingPeriod = 'monthly' | 'yearly'

/** All plan values stored on User.plan (including free). */
export type UserPlan = 'free' | PremiumPlan

export const PAID_PLANS: readonly PremiumPlan[] = ['premium', 'premium_plus']

export interface PlanPricing {
  /** Machine plan value, as stored on User.plan */
  plan: PremiumPlan
  /** Human label (also the i18n key suffix: premium.planPremium / planPremiumPlus) */
  label: string
  monthlyCents: number
  yearlyCents: number
}

/**
 * Exact pricing — the CEO-approved rates. Do not change without a product
 * decision: the same constants drive the UI, the checkout API and the
 * webhook's underpayment check.
 */
export const PLAN_PRICING: Record<PremiumPlan, PlanPricing> = {
  premium: {
    plan: 'premium',
    label: 'Premium',
    monthlyCents: 500, // $5.00
    yearlyCents: 3000, // $30.00 (save 50%)
  },
  premium_plus: {
    plan: 'premium_plus',
    label: 'Premium+',
    monthlyCents: 1500, // $15.00
    yearlyCents: 9000, // $90.00 (save 50%)
  },
}

/** Days added to premiumUntil per billing period. */
export const PERIOD_DAYS: Record<BillingPeriod, number> = {
  monthly: 30,
  yearly: 365,
}

/** Price in US cents for one plan × period combination. */
export function priceCents(plan: PremiumPlan, period: BillingPeriod): number {
  return period === 'monthly' ? PLAN_PRICING[plan].monthlyCents : PLAN_PRICING[plan].yearlyCents
}

// ---------------------------------------------------------------------------
// Entitlement checks
// ---------------------------------------------------------------------------

/**
 * Is this user's paid plan (Premium OR Premium+) active right now?
 * premiumUntil NULL means "never expires" (operator grant) — anything in the
 * past, or plan "free", means no alerts, no gating pass, no exceptions.
 */
export function isPremiumActive(user: { plan: string; premiumUntil: Date | null }): boolean {
  if (!(PAID_PLANS as readonly string[]).includes(user.plan)) return false
  if (!user.premiumUntil) return true // never-expires grant
  return user.premiumUntil.getTime() > Date.now()
}

/** Active Premium+ specifically (editorial quotas, author tooling). */
export function isPremiumPlusActive(user: { plan: string; premiumUntil: Date | null }): boolean {
  return user.plan === 'premium_plus' && isPremiumActive(user)
}

/** Human plan name for bot messages ("Premium+" / "Premium" / "Free"). */
export function planDisplayName(user: { plan: string; premiumUntil: Date | null }): string {
  if (user.plan === 'premium_plus') return isPremiumActive(user) ? 'Premium+' : 'Free (Premium+ expired)'
  if (user.plan === 'premium') return isPremiumActive(user) ? 'Premium' : 'Free (Premium expired)'
  return 'Free'
}

// ---------------------------------------------------------------------------
// Order ids — the BlockBee routing contract
// ---------------------------------------------------------------------------

/**
 * Order-id prefixes (the ONLY thing the IPN webhook may infer from the id —
 * everything else is read from the PremiumOrder row itself):
 *
 *   prem_m_      Premium, monthly
 *   prem_y_      Premium, yearly
 *   premplus_m_  Premium+, monthly
 *   premplus_y_  Premium+, yearly
 */
export const PREMIUM_ORDER_PREFIXES = ['prem_m_', 'prem_y_', 'premplus_m_', 'premplus_y_'] as const

/** Does this BlockBee order_id belong to the premium checkout (vs ads)? */
export function isPremiumOrderId(orderId: string): boolean {
  return PREMIUM_ORDER_PREFIXES.some((p) => orderId.startsWith(p))
}

/** Build a unique order id: `<prefix><userId>_<8 hex random>`. */
export function buildPremiumOrderId(
  plan: PremiumPlan,
  period: BillingPeriod,
  userId: string,
  randHex: string,
): string {
  const head = plan === 'premium' ? 'prem' : 'premplus'
  const tail = period === 'monthly' ? 'm' : 'y'
  return `${head}_${tail}_${userId}_${randHex}`
}

/** Editor-friendly money format used in logs and bot replies ($5.00). */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
