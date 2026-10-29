/**
 * Merklane Premium — BlockBee checkout orders (create → pay → confirm).
 *
 * Mirrors the Ads top-up flow (src/lib/ads/topup.ts) but with its own table,
 * its own id namespace (prem_/premplus_ prefixes) and its own confirmation
 * semantics: a subscription has an EXACT price, so a confirmed payment only
 * activates the plan when the received USD value covers the price (minus a
 * 10% conversion-slippage tolerance). Underpayments are logged, never
 * activated — the operator resolves them from the PaymentLog.
 *
 * Activation extends premiumUntil from max(now, current premiumUntil) so a
 * renewal bought before expiry stacks seamlessly, and flips the order status
 * atomically inside the same transaction (updateMany count = 1 guard) — a
 * retried webhook can never double-grant days.
 */
import crypto from 'node:crypto'
import type { Prisma, PremiumOrder as PremiumOrderRow } from '@prisma/client'
import { db } from '@/lib/db'
import { logPayment } from '@/lib/payment-log'
import { env } from '@/lib/env'
import {
  BlockBeeApiError,
  createPaymentIntention,
} from '@/lib/ads/blockbee'
import {
  PERIOD_DAYS,
  buildPremiumOrderId,
  priceCents,
  type BillingPeriod,
  type PremiumPlan,
} from '@/lib/premium/plan'

/** Accepted underpayment tolerance vs. the exact price (crypto conversion slippage). */
export const UNDERPAYMENT_TOLERANCE = 0.9 // ≥ 90% of the price still activates

// ---------------------------------------------------------------------------
// Checkout creation (POST /api/premium/checkout)
// ---------------------------------------------------------------------------

export interface CreatedCheckout {
  id: string
  plan: PremiumPlan
  period: BillingPeriod
  walletAddress: string
  amountExpectedCents: number
  status: string
  provider: string
  coin: string
}

/**
 * Create a pending PremiumOrder + BlockBee payment intention for one user.
 *
 * The order id embeds the routing prefix (prem_m_<userId>_… etc.), the
 * callback URL embeds the id + an unguessable nonce — both echoed back by
 * every IPN. Rows are created before the processor call and dropped again
 * when BlockBee fails to issue an address, so nothing payable can dangle.
 */
export async function createPremiumCheckout(
  user: { id: string },
  plan: PremiumPlan,
  period: BillingPeriod,
  coin: string,
): Promise<
  | { ok: true; checkout: CreatedCheckout }
  | { ok: false; status: number; message: string; code?: string }
> {
  const amountCents = priceCents(plan, period)
  const days = PERIOD_DAYS[period]
  const randHex = crypto.randomBytes(5).toString('hex')
  const id = buildPremiumOrderId(plan, period, user.id, randHex)

  const callbackNonce = crypto.randomBytes(16).toString('hex')
  const callbackUrl = `${env.APP_URL}/api/webhooks/blockbee?order_id=${encodeURIComponent(id)}&nonce=${callbackNonce}`

  // Row first (address placeholder), address filled in right after — the
  // same insert-then-update dance as the Ads top-up flow.
  await db.premiumOrder.create({
    data: {
      id,
      userId: user.id,
      plan,
      period,
      days,
      amountExpected: amountCents,
      status: 'pending',
      provider: 'blockbee',
      coin,
      callbackNonce,
      walletAddress: '',
    },
  })

  try {
    const intention = await createPaymentIntention({ coin, callbackUrl })
    const row = await db.premiumOrder.update({
      where: { id },
      data: { walletAddress: intention.addressIn },
    })
    return { ok: true, checkout: serializeOrder(row) }
  } catch (err) {
    // No address → nothing payable. Drop the intention and surface the
    // processor-provided error message (never internals).
    await db.premiumOrder.delete({ where: { id } }).catch(() => undefined)
    if (err instanceof BlockBeeApiError) {
      return { ok: false, status: 502, message: `BlockBee: ${err.message}`, code: 'blockbee_error' }
    }
    return { ok: false, status: 502, message: 'Payment processor unavailable — try again.', code: 'blockbee_error' }
  }
}

// ---------------------------------------------------------------------------
// Serialization (GET /api/premium/checkout/[id])
// ---------------------------------------------------------------------------

export function serializeOrder(row: PremiumOrderRow): CreatedCheckout {
  return {
    id: row.id,
    plan: row.plan as PremiumPlan,
    period: row.period as BillingPeriod,
    walletAddress: row.walletAddress,
    amountExpectedCents: row.amountExpected,
    status: row.status,
    provider: row.provider,
    coin: row.coin ?? '',
  }
}

// ---------------------------------------------------------------------------
// Confirmation (BlockBee IPN — confirmed payment, pending=0)
// ---------------------------------------------------------------------------

export type ActivateResult =
  | { ok: true; activated: true; plan: PremiumPlan; until: Date; receivedCents: number }
  | { ok: true; activated: false; reason: 'already_confirmed' | 'underpaid' }
  | { ok: false; reason: 'not_found' }

/**
 * Confirm a premium order and extend the user's subscription — exactly once.
 *
 * Underpayment policy: a confirmed payment below 90% of the exact price does
 * NOT activate. The order stays pending (BlockBee may deliver further
 * payments to the same address) and the event lands in PaymentLog for the
 * operator to resolve manually (refund or manual grant).
 */
export async function confirmPremiumOrder(
  orderId: string,
  opts: { receivedCents: number; txHash?: string | null; uuid?: string | null },
): Promise<ActivateResult> {
  return await db.$transaction(async (tx) => {
    const order = await tx.premiumOrder.findUnique({ where: { id: orderId } })
    if (!order) return { ok: false, reason: 'not_found' } satisfies ActivateResult

    if (order.status !== 'pending') {
      return { ok: true, activated: false, reason: 'already_confirmed' } satisfies ActivateResult
    }

    // Snapshot the payment details on the row first (audit trail — even for
    // underpayments), then decide.
    await tx.premiumOrder
      .update({
        where: { id: order.id },
        data: {
          uuid: opts.uuid ?? order.uuid,
          txHash: opts.txHash ?? order.txHash,
        },
      })
      .catch(() => undefined)

    if (opts.receivedCents < Math.floor(order.amountExpected * UNDERPAYMENT_TOLERANCE)) {
      return { ok: true, activated: false, reason: 'underpaid' } satisfies ActivateResult
    }

    // Atomic flip pending → confirmed: only the first webhook to arrive
    // performs the grant; retries are no-ops.
    const flipped = await tx.premiumOrder.updateMany({
      where: { id: order.id, status: 'pending' },
      data: {
        status: 'confirmed',
        confirmedAt: new Date(),
        amountReceived: opts.receivedCents,
      },
    })
    if (flipped.count !== 1) {
      return { ok: true, activated: false, reason: 'already_confirmed' } satisfies ActivateResult
    }

    // Renewals stack: a year bought with 2 months left runs 14 months.
    const user = await tx.user.findUnique({
      where: { id: order.userId },
      select: { premiumUntil: true },
    })
    const base =
      user?.premiumUntil && user.premiumUntil.getTime() > Date.now() ? user.premiumUntil : new Date()
    const until = new Date(base.getTime() + order.days * 24 * 3600 * 1000)

    await tx.user.update({
      where: { id: order.userId },
      data: { plan: order.plan, premiumUntil: until },
    })

    return {
      ok: true,
      activated: true,
      plan: order.plan as PremiumPlan,
      until,
      receivedCents: opts.receivedCents,
    } satisfies ActivateResult
  })
}

/** PaymentLog helper with the premium reference shape. */
export async function logPremiumPayment(
  entry: {
    event: string
    ok: boolean
    orderId: string
    userId: string
    amountCents?: number
    externalId?: string | null
    detail?: Record<string, unknown>
  },
): Promise<void> {
  await logPayment({
    source: 'blockbee_ipn',
    event: entry.event,
    ok: entry.ok,
    externalId: entry.externalId ?? undefined,
    referenceId: entry.orderId,
    userId: entry.userId,
    amountCents: entry.amountCents,
    detail: { target: 'premium', ...(entry.detail ?? {}) } as never,
  })
}

/** Prisma type re-export for route handlers. */
export type PremiumOrderTx = Prisma.TransactionClient
