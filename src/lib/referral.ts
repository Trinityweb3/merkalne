/**
 * Referral system — 50% commission on referred users' payments.
 *
 * Mechanics:
 *   • Every user gets a unique `referralCode` (shareable via
 *     /auth?mode=register&ref=CODE). New accounts created with a valid code
 *     store `referredById` — write-once, at registration only.
 *   • When a referred user's ad top-up is CONFIRMED (BlockBee IPN, admin
 *     confirm, or the demo simulate path — all funnel through
 *     confirmTopUp()), 50% of the credited amount lands in the referrer's
 *     `referralBalance` (US cents). The credit runs inside the same DB
 *     transaction as the top-up's pending→confirmed flip, so it is exactly
 *     once: a webhook fired twice credits once.
 *   • Referral balance is withdrawn through the BlockBee payout chain
 *     (see /api/account/referral/withdraw). The balance is deducted only
 *     when BlockBee confirms the payout on-chain — failed/expired payouts
 *     never take the user's money.
 *
 * Self-referral is impossible by construction: a code belongs to an existing
 * user, and referredBy is only ever set at account creation. Referral loops
 * cannot form for the same reason (A's code existed before B registered, so
 * B cannot be A's referrer and vice versa).
 *
 * When Premium purchases land (stage-2 billing), the same
 * creditReferralCommission() helper is called from the premium checkout
 * confirmation — the "(or buys Premium later)" clause of the spec.
 */
import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

/** Commission rate — 50% of every confirmed referred payment. */
export const REFERRAL_RATE = 0.5

/**
 * Unambiguous alphabet (no I/L/O/0/1) — codes are dictated, typed and read
 * aloud, so lookalike glyphs must not exist.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

/** Generate a random referral code (does not check uniqueness). */
export function generateReferralCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return code
}

/** Generate a code that is actually free (unique constraint satisfied). */
export async function createUniqueReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateReferralCode()
    const clash = await db.user.findUnique({ where: { referralCode: code }, select: { id: true } })
    if (!clash) return code
  }
  // ~1e12 codes; 8 consecutive collisions is astronomically unlikely.
  throw new Error('Could not generate a unique referral code')
}

/**
 * Look up the owner of a referral code (normalised: trimmed + uppercased).
 * Returns null for unknown codes — callers treat this as "no referral".
 */
export async function findReferrerByCode(
  code: string,
): Promise<{ id: string; name: string | null; email: string } | null> {
  const normalized = code.trim().toUpperCase()
  if (!/^[A-Z0-9]{4,16}$/.test(normalized)) return null
  const referrer = await db.user.findUnique({
    where: { referralCode: normalized },
    select: { id: true, name: true, email: true },
  })
  return referrer ?? null
}

/**
 * Lazily backfill a referral code for legacy rows created before this
 * launch (their referralCode is NULL). Idempotent — safe to call on every
 * profile read.
 */
export async function ensureReferralCode(userId: string): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { referralCode: true } })
  if (user?.referralCode) return user.referralCode
  const code = await createUniqueReferralCode()
  // Conditional write: only fills the column while it is still NULL, so a
  // concurrent backfill (or a code set elsewhere) can never be overwritten.
  const filled = await db.user.updateMany({
    where: { id: userId, referralCode: null },
    data: { referralCode: code },
  })
  if (filled.count === 1) return code
  // Lost the race (or user vanished) — read the winner's value.
  const again = await db.user.findUnique({ where: { id: userId }, select: { referralCode: true } })
  return again?.referralCode ?? code
}

/**
 * Credit the referrer's commission for one confirmed payment — called
 * INSIDE the confirmTopUp transaction so the pending→confirmed flip guards
 * it (exactly once). Uses the supplied transaction client, never the global
 * db handle.
 */
export async function creditReferralCommission(
  tx: Prisma.TransactionClient,
  opts: { payerId: string; amountCents: number; topUpId: string },
): Promise<{ referrerId: string; referrerBalanceAfter: number; commissionCents: number } | null> {
  const payer = await tx.user.findUnique({
    where: { id: opts.payerId },
    select: { referredById: true },
  })
  if (!payer?.referredById) return null

  const commission = Math.floor(opts.amountCents * REFERRAL_RATE)
  if (commission < 1) return null

  const referrer = await tx.user.update({
    where: { id: payer.referredById },
    data: { referralBalance: { increment: commission } },
    select: { referralBalance: true },
  })

  await tx.paymentLog.create({
    data: {
      source: 'referral_commission',
      event: 'commission_credited',
      ok: true,
      referenceId: opts.topUpId,
      userId: payer.referredById,
      amountCents: commission,
      detail: {
        payerId: opts.payerId,
        rate: REFERRAL_RATE,
        paymentCents: opts.amountCents,
      } as never,
    },
  })

  return {
    referrerId: payer.referredById,
    referrerBalanceAfter: referrer.referralBalance,
    commissionCents: commission,
  }
}

/** Build the shareable referral link for a code. */
export function referralLink(code: string, appUrl: string): string {
  return `${appUrl}/auth?mode=register&ref=${encodeURIComponent(code)}`
}
