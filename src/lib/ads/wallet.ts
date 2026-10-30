/**
 * Merklane Ads — the wallet & ledger transaction service.
 *
 * ONE wallet per advertiser (Wallet), every money movement recorded in the
 * append-only LedgerEntry (see prisma/schema.prisma for the model comments).
 * All functions take a Prisma transaction client so the CALLER composes the
 * atomic unit (top-up credit + referral commission + payment log; campaign
 * create + budget reservation; delete + refund …).
 *
 * Money is INTEGER micro-USD everywhere ($1.00 = 1_000_000; see money.ts).
 * Floats never touch money.
 *
 * The invariant enforced by the ledger + the conditional updateMany guards:
 *
 *   wallet.available + wallet.reserved == Σ(CREDIT) − Σ(CHARGE)
 *
 * • creditWalletTopUp     available += X        ledger CREDIT  +X   (exactly-once via unique eventId — BlockBee IPN retries are harmless)
 * • reserveCampaignBudget available −= X        ledger RESERVE −X   (campaign create / "add funds"; conditional decrement can never overdraw)
 *                        reserved  += X
 * • chargeReservation     reserved  −= X        ledger CHARGE  −X   (a CPC click / CPM view finalised its BudgetReservation; conditional guard keeps reserved ≥ 0)
 * • refundCampaignBudget  reserved  −= X        ledger REFUND  +X   (campaign deleted — unspent budget back to available)
 *                        available += X
 */
import { db } from '@/lib/db'
import type { Prisma, Wallet } from '@prisma/client'

/** Minimum "add funds" / allocation: $1.00 (2,000,000 µUSD per dollar → 100 cents). */
export const MIN_ALLOCATION_CENTS = 100
export const MIN_ALLOCATION_MICRO_USD = MIN_ALLOCATION_CENTS * 10_000

// ---------------------------------------------------------------------------
// Wallet row (lazy creation — most users never touch ads)
// ---------------------------------------------------------------------------

/**
 * The user's wallet row, creating it on first access. Safe under races:
 * the unique index on Wallet.userId turns a double-create into P2002,
 * which we resolve by re-reading.
 */
export async function getOrCreateWallet(
  userId: string,
  tx: Prisma.TransactionClient | typeof db = db,
): Promise<Wallet> {
  const existing = await tx.wallet.findUnique({ where: { userId } })
  if (existing) return existing
  try {
    return await tx.wallet.create({ data: { userId } })
  } catch (err) {
    // Lost a create race — the winner's row is what we want.
    if ((err as { code?: string })?.code === 'P2002') {
      const again = await tx.wallet.findUnique({ where: { userId } })
      if (again) return again
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Movements — each returns the post-movement wallet state where useful
// ---------------------------------------------------------------------------

export interface MovementOk {
  ok: true
  availableMicroUsd: number
  reservedMicroUsd: number
}
export interface MovementFail {
  ok: false
  reason: 'insufficient_wallet' | 'invariant_broken'
}

/**
 * Credit a confirmed top-up to the wallet. The caller MUST have flipped a
 * status field first (CryptoTopUp pending → confirmed) so retries die before
 * reaching here; the unique eventId is the second line of defence — a
 * duplicate insert throws, rolling back the whole transaction.
 */
export async function creditWalletTopUp(
  tx: Prisma.TransactionClient,
  input: { userId: string; amountMicroUsd: number; eventId: string },
): Promise<MovementOk> {
  if (!Number.isInteger(input.amountMicroUsd) || input.amountMicroUsd <= 0) {
    throw new Error(`creditWalletTopUp: non-positive amount ${input.amountMicroUsd}`)
  }
  const wallet = await getOrCreateWallet(input.userId, tx)
  const updated = await tx.wallet.update({
    where: { id: wallet.id },
    data: { availableMicroUsd: { increment: input.amountMicroUsd } },
  })
  await tx.ledgerEntry.create({
    data: {
      walletId: wallet.id,
      type: 'credit',
      amountMicroUsd: input.amountMicroUsd,
      campaignId: null,
      eventId: input.eventId,
    },
  })
  return { ok: true, availableMicroUsd: updated.availableMicroUsd, reservedMicroUsd: updated.reservedMicroUsd }
}

/**
 * Move money from the wallet's available balance into a campaign's budget.
 * The FIRST statement is a conditional decrement (`WHERE available >= X`) —
 * two concurrent allocations can never overdraw the wallet.
 */
export async function reserveCampaignBudget(
  tx: Prisma.TransactionClient,
  input: { userId: string; campaignId: string; amountMicroUsd: number; eventId: string },
): Promise<MovementOk | MovementFail> {
  if (!Number.isInteger(input.amountMicroUsd) || input.amountMicroUsd <= 0) {
    throw new Error(`reserveCampaignBudget: non-positive amount ${input.amountMicroUsd}`)
  }
  const wallet = await getOrCreateWallet(input.userId, tx)
  const debited = await tx.wallet.updateMany({
    where: { id: wallet.id, availableMicroUsd: { gte: input.amountMicroUsd } },
    data: {
      availableMicroUsd: { decrement: input.amountMicroUsd },
      reservedMicroUsd: { increment: input.amountMicroUsd },
    },
  })
  if (debited.count !== 1) return { ok: false, reason: 'insufficient_wallet' }

  await tx.ledgerEntry.create({
    data: {
      walletId: wallet.id,
      type: 'reserve',
      amountMicroUsd: -input.amountMicroUsd,
      campaignId: input.campaignId,
      eventId: input.eventId,
    },
  })
  return {
    ok: true,
    availableMicroUsd: wallet.availableMicroUsd - input.amountMicroUsd,
    reservedMicroUsd: wallet.reservedMicroUsd + input.amountMicroUsd,
  }
}

/**
 * Charge a finalised BudgetReservation: the money leaves the wallet for
 * good (platform revenue). Conditional on reserved ≥ amount — count 0 means
 * the ledger invariant is broken (never expected); the caller rolls back.
 */
export async function chargeReservation(
  tx: Prisma.TransactionClient,
  input: { userId: string; campaignId: string; reservationId: string; amountMicroUsd: number },
): Promise<MovementOk | MovementFail> {
  if (!Number.isInteger(input.amountMicroUsd) || input.amountMicroUsd <= 0) {
    throw new Error(`chargeReservation: non-positive amount ${input.amountMicroUsd}`)
  }
  const wallet = await getOrCreateWallet(input.userId, tx)
  const debited = await tx.wallet.updateMany({
    where: { id: wallet.id, reservedMicroUsd: { gte: input.amountMicroUsd } },
    data: { reservedMicroUsd: { decrement: input.amountMicroUsd } },
  })
  if (debited.count !== 1) return { ok: false, reason: 'invariant_broken' }

  await tx.ledgerEntry.create({
    data: {
      walletId: wallet.id,
      type: 'charge',
      amountMicroUsd: -input.amountMicroUsd,
      campaignId: input.campaignId,
      // Deterministic exactly-once key: a replayed click beacon can never
      // double-charge (the unique index rejects the second row).
      eventId: `charge:${input.reservationId}`,
    },
  })
  return {
    ok: true,
    availableMicroUsd: wallet.availableMicroUsd,
    reservedMicroUsd: wallet.reservedMicroUsd - input.amountMicroUsd,
  }
}

/**
 * Release a deleted campaign's unspent budget back to the wallet. Used by
 * the delete action; eventId `refund:<campaignId>` is deterministic so a
 * double-delete can never double-refund.
 */
export async function refundCampaignBudget(
  tx: Prisma.TransactionClient,
  input: { userId: string; campaignId: string; amountMicroUsd: number },
): Promise<MovementOk | MovementFail> {
  if (!Number.isInteger(input.amountMicroUsd) || input.amountMicroUsd <= 0) {
    throw new Error(`refundCampaignBudget: non-positive amount ${input.amountMicroUsd}`)
  }
  const wallet = await getOrCreateWallet(input.userId, tx)
  const released = await tx.wallet.updateMany({
    where: { id: wallet.id, reservedMicroUsd: { gte: input.amountMicroUsd } },
    data: {
      reservedMicroUsd: { decrement: input.amountMicroUsd },
      availableMicroUsd: { increment: input.amountMicroUsd },
    },
  })
  if (released.count !== 1) return { ok: false, reason: 'invariant_broken' }

  await tx.ledgerEntry.create({
    data: {
      walletId: wallet.id,
      type: 'refund',
      amountMicroUsd: input.amountMicroUsd,
      campaignId: input.campaignId,
      eventId: `refund:${input.campaignId}`,
    },
  })
  return {
    ok: true,
    availableMicroUsd: wallet.availableMicroUsd + input.amountMicroUsd,
    reservedMicroUsd: wallet.reservedMicroUsd - input.amountMicroUsd,
  }
}
