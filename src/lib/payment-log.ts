/**
 * PaymentLog — append-only audit trail for every payment event.
 *
 * Written from: the BlockBee IPN/payout webhooks (accepted AND rejected),
 * the admin manual-confirm path, the demo simulate path, referral
 * commission credits and referral withdrawal requests. Fire-and-forget:
 * a logging failure must never break the payment flow itself.
 */
import { db } from '@/lib/db'

export type PaymentSource =
  | 'blockbee_ipn'
  | 'blockbee_payout'
  | 'admin_confirm'
  | 'simulate_confirm'
  | 'referral_commission'
  | 'referral_withdraw'

export interface PaymentLogEntry {
  source: PaymentSource
  /** What happened, e.g. "received" | "credited" | "rejected" | "done" | "failed" */
  event: string
  ok?: boolean
  /** BlockBee payment uuid / payout id / on-chain tx hash */
  externalId?: string | null
  /** CryptoTopUp.id or ReferralWithdrawal.id this event belongs to */
  referenceId?: string | null
  userId?: string | null
  amountCents?: number | null
  detail?: Record<string, unknown> | null
}

/** Persist one audit entry; never throws (logs to console on DB failure). */
export async function logPayment(entry: PaymentLogEntry): Promise<void> {
  try {
    await db.paymentLog.create({
      data: {
        source: entry.source,
        event: entry.event,
        ok: entry.ok ?? true,
        externalId: entry.externalId ?? null,
        referenceId: entry.referenceId ?? null,
        userId: entry.userId ?? null,
        amountCents: entry.amountCents ?? null,
        detail: (entry.detail ?? undefined) as never,
      },
    })
  } catch (err) {
    console.error('[payment-log] write failed:', err, JSON.stringify(entry).slice(0, 500))
  }
}
