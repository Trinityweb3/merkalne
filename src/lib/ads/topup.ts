/**
 * Merklane Ads — crypto top-up flow.
 *
 * An advertiser creates a pending CryptoTopUp from the Wallet tab and is
 * shown a UNIQUE deposit address together with the expected amount. Once
 * the incoming payment is confirmed the top-up flips to "confirmed" and
 * the amount is credited to the advertiser's unified WALLET
 * (Wallet.availableMicroUsd + an immutable LedgerEntry of type CREDIT —
 * exactly once: the status field guards the double credit, and the ledger
 * eventId `topup:<id>` is unique so a replayed webhook can never post a
 * second row) — and, when the advertiser was referred, 50% of the credited
 * amount lands in the referrer's referralBalance inside the same
 * transaction. Campaign budgets are reserved from the wallet separately
 * (campaign create / "add funds"), so deposits work even before any
 * campaign exists.
 *
 * The top-up domain keeps US-cent integers (CryptoTopUp, referral
 * commissions); cents are converted to micro-USD exactly once, at the
 * wallet boundary (1 cent = 10 000 µUSD).
 *
 * Providers (ADS_TOPUP_MODE, auto-resolved — see topUpMode()):
 *   • blockbee — production. The BlockBee processor (src/lib/ads/blockbee.ts)
 *     issues a hosted deposit address per intention (GET /{coin}/create/),
 *     performs AML screening on the funds, and confirms via the IPN webhook
 *     at /api/webhooks/blockbee. Stablecoins + major coins on cheap
 *     networks; TRON banned by policy.
 *   • manual (fallback) — the deterministic MOCK "HD wallet" address
 *     (HMAC-SHA256(seed, id)); an ADMIN confirms via
 *     POST /api/admin/ads/topups/:id/confirm after checking the wallet.
 *   • simulate — demos/local only: the advertiser self-confirms via
 *     POST /api/ads/topups/:id/simulate.
 */
import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { blockbeeConfigured } from '@/lib/ads/blockbee'
import { creditWalletTopUp } from '@/lib/ads/wallet'
import { centsToMicro } from '@/lib/ads/money'
import { creditReferralCommission } from '@/lib/referral'

export const TOPUP_MIN_CENTS = 500 // $5.00 — keeps the ledger free of dust
export const TOPUP_MAX_CENTS = 500_000 // $5,000.00 per intention

/**
 * Deterministic deposit address for one top-up intention (mock HD wallet —
 * MANUAL/SIMULATE fallback modes only; BlockBee mode uses hosted addresses).
 * 40 hex chars + 0x prefix = the EVM address shape.
 */
export function deriveDepositAddress(topUpId: string): string {
  const seed = env.ADS_TOPUP_SEED ?? 'merklane-topup-dev-seed'
  const digest = crypto
    .createHmac('sha256', seed)
    .update(`merklane-topup:${topUpId}`)
    .digest('hex')
  return `0x${digest.slice(0, 40)}`
}

export type TopUpMode = 'manual' | 'simulate' | 'blockbee'

/**
 * Resolve the ACTIVE top-up mode:
 *   • explicit ADS_TOPUP_MODE (manual | simulate | blockbee) wins;
 *   • unset/empty → AUTO: "blockbee" when BLOCKBEE_API_KEY is configured,
 *     "manual" otherwise (the pre-BlockBee behaviour).
 */
export function topUpMode(): TopUpMode {
  if (env.ADS_TOPUP_MODE) return env.ADS_TOPUP_MODE
  return blockbeeConfigured() ? 'blockbee' : 'manual'
}

// ---------------------------------------------------------------------------
// Crediting (idempotent, referral-aware)
// ---------------------------------------------------------------------------

export interface CreditResult {
  ok: boolean
  reason?: 'not_found' | 'already_confirmed'
  creditedCents?: number
  /** Referral commission paid on this confirmation (null = no referrer / sub-cent) */
  referral?: { referrerId: string; commissionCents: number } | null
}

/**
 * Confirm a pending top-up and credit the advertiser's WALLET — exactly
 * once. The whole mutation runs inside a transaction whose first statement
 * flips the status atomically (updateMany count 0 → someone confirmed first).
 *
 * The referral commission (50% of the credited amount to the advertiser's
 * referrer, if any) is written inside the SAME transaction — the atomic
 * status flip therefore makes the commission exactly-once as well, no matter
 * how often the same webhook fires.
 */
export async function confirmTopUp(
  topUpId: string,
  opts?: {
    receivedCents?: number
    source?: 'manual' | 'simulate' | 'blockbee'
    txHash?: string | null
    uuid?: string | null
  },
): Promise<CreditResult> {
  const source = opts?.source ?? 'manual'
  return await db.$transaction(async (tx) => {
    // Atomic flip: only the first confirmer sees count 1.
    const flipped = await tx.cryptoTopUp.updateMany({
      where: { id: topUpId, status: 'pending' },
      data: { status: 'confirmed', confirmedAt: new Date() },
    })
    if (flipped.count !== 1) {
      const exists = await tx.cryptoTopUp.findUnique({ where: { id: topUpId } })
      return {
        ok: false,
        reason: !exists ? 'not_found' : 'already_confirmed',
      } satisfies CreditResult
    }

    const topUp = (await tx.cryptoTopUp.findUnique({ where: { id: topUpId } }))!
    const received = Math.max(0, Math.floor(opts?.receivedCents ?? topUp.amountExpected))

    await tx.cryptoTopUp.update({
      where: { id: topUpId },
      data: { amountReceived: received },
    })
    // The credit lands in the advertiser's unified WALLET (immutable CREDIT
    // ledger row, eventId topup:<id> — idempotent against IPN retries) —
    // campaign budgets are reserved from it later (campaign create / "add
    // funds"), so a deposit is never blocked on a campaign existing.
    await creditWalletTopUp(tx, {
      userId: topUp.advertiserId,
      amountMicroUsd: centsToMicro(received),
      eventId: `topup:${topUp.id}`,
    })

    // Referral commission — same transaction, guarded by the flip above.
    const referral = await creditReferralCommission(tx, {
      payerId: topUp.advertiserId,
      amountCents: received,
      topUpId,
    })

    await writeConfirmLog(tx, {
      source,
      topUpId,
      advertiserId: topUp.advertiserId,
      receivedCents: received,
      txHash: opts?.txHash ?? null,
      uuid: opts?.uuid ?? null,
    })

    return {
      ok: true,
      creditedCents: received,
      referral: referral ? { referrerId: referral.referrerId, commissionCents: referral.commissionCents } : null,
    } satisfies CreditResult
  })
}

function writeConfirmLog(
  tx: Prisma.TransactionClient,
  entry: {
    source: 'manual' | 'simulate' | 'blockbee'
    topUpId: string
    advertiserId: string
    receivedCents: number
    txHash: string | null
    uuid: string | null
  },
): Promise<unknown> {
  return tx.paymentLog.create({
    data: {
      source: entry.source === 'blockbee' ? 'blockbee_ipn' : entry.source === 'simulate' ? 'simulate_confirm' : 'admin_confirm',
      event: 'credited',
      ok: true,
      externalId: entry.txHash ?? entry.uuid,
      referenceId: entry.topUpId,
      userId: entry.advertiserId,
      amountCents: entry.receivedCents,
      detail: { target: 'wallet', provider: entry.source } as never,
    },
  })
}
