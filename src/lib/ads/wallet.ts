/**
 * Merklane Ads — the advertiser wallet.
 *
 * User.adBalance (US cents) is the money the advertiser deposited but has
 * not committed to a campaign yet. Campaign budgets are allocated from it:
 *
 *   wallet  ── allocate (create / "add funds") ──▶  campaign.balance
 *                                                    (what the auction bills)
 *
 * The allocation is a single transaction whose first statement is a
 * CONDITIONAL decrement (`WHERE adBalance >= amount`) — two concurrent
 * allocations can never overdraw the wallet, exactly like the auction's
 * per-impression billing guards the campaign balance.
 */
import { db } from '@/lib/db'

/** Absolute floor for any single allocation: $1.00. */
export const MIN_ALLOCATION_CENTS = 100

/** A new campaign must buy at least this many views at its bid. */
export const MIN_START_VIEWS = 50

/**
 * Minimum initial budget for a campaign at the given bid: $1.00 AND enough
 * for at least MIN_START_VIEWS impressions (e.g. 2¢ bid → $1.00 = 50 views;
 * 10¢ bid → $5.00 = 50 views).
 */
export function minBudgetCents(bidPerView: number): number {
  return Math.max(MIN_ALLOCATION_CENTS, Math.max(1, bidPerView) * MIN_START_VIEWS)
}

export interface AllocateResult {
  ok: boolean
  reason?: 'campaign_not_found' | 'insufficient_wallet' | 'amount_too_small'
  allocatedCents?: number
  campaignBalanceCents?: number
  walletBalanceCents?: number
}

/**
 * Move money from the advertiser's wallet into one of their campaigns.
 * Runs as one transaction:
 *   1. conditional wallet decrement (count 0 → insufficient funds)
 *   2. campaign balance increment
 * The campaign is NOT auto-resumed — the advertiser resumes explicitly
 * (a pause may have been deliberate, not just a drained balance).
 */
export async function allocateWalletToCampaign(
  userId: string,
  campaignId: string,
  amountCents: number,
): Promise<AllocateResult> {
  if (!Number.isInteger(amountCents) || amountCents < MIN_ALLOCATION_CENTS) {
    return { ok: false, reason: 'amount_too_small' }
  }

  return await db.$transaction(async (tx) => {
    const campaign = await tx.adCampaign.findUnique({ where: { id: campaignId } })
    if (!campaign || campaign.advertiserId !== userId || campaign.status === 'ended') {
      return { ok: false, reason: 'campaign_not_found' } satisfies AllocateResult
    }

    // Conditional decrement — the overdraw guard.
    const debited = await tx.user.updateMany({
      where: { id: userId, adBalance: { gte: amountCents } },
      data: { adBalance: { decrement: amountCents } },
    })
    if (debited.count !== 1) {
      return { ok: false, reason: 'insufficient_wallet' } satisfies AllocateResult
    }

    const updated = await tx.adCampaign.update({
      where: { id: campaignId },
      data: { balance: { increment: amountCents } },
      select: { balance: true },
    })
    const wallet = await tx.user.findUnique({
      where: { id: userId },
      select: { adBalance: true },
    })

    return {
      ok: true,
      allocatedCents: amountCents,
      campaignBalanceCents: updated.balance,
      walletBalanceCents: wallet?.adBalance ?? 0,
    } satisfies AllocateResult
  })
}
