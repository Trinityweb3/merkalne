/**
 * Merklane Ads Phase 3 — reporting aggregation (server-side).
 *
 * The Reports tab (and its CSV export) is fed from TWO sources, never
 * mixed up:
 *
 *   • AdEvent  — the delivery funnel: loaded_impression (serves),
 *                viewable_impression (viewability), valid_click (clicks).
 *                Grouped per campaign + event type.
 *   • Ledger   — the money: spent = Σ|charge| (campaignBudgetStates, the
 *                same derivation the rest of the dashboard uses — there is
 *                no mutable balance column anywhere).
 *
 * Derived metrics:
 *   CTR   = clicks / impressions      (null while impressions = 0)
 *   eCPC  = spent / clicks            (null while clicks = 0 or spent = 0)
 *
 * Null (never 0 / "0%") is what the UI and the CSV render as the em dash —
 * see src/lib/ads/report-format.ts.
 */
import { db } from '@/lib/db'
import { campaignBudgetStates } from '@/lib/ads/auction'
import type { BillingModel } from '@/lib/ads/money'

export interface CampaignReportRow {
  campaignId: string
  name: string
  /** Campaign status as stored ("active" | "paused" | …). */
  status: string
  format: string
  billingModel: BillingModel
  /** Display label: "$0.50 per click" / "$2.00 per 1000 views". */
  bidLabel: string
  /** loaded_impression count — the serves. */
  impressions: number
  /** viewable_impression count — the viewability-confirmed subset. */
  viewableImpressions: number
  /** valid_click count. */
  clicks: number
  /** clicks / impressions; null while impressions = 0. */
  ctr: number | null
  /** Σ|charge| from the ledger. */
  spentMicroUsd: number
  /** spent / clicks; null while clicks = 0 or spent = 0. */
  ecpcMicroUsd: number | null
}

/**
 * One row per campaign of this advertiser (all states — drafts included;
 * a draft simply has no events and shows em dashes), newest first.
 */
export async function campaignReportRows(userId: string): Promise<CampaignReportRow[]> {
  const campaigns = await db.campaign.findMany({
    where: { advertiserId: userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      status: true,
      format: true,
      billingModel: true,
      bidMicroUsd: true,
    },
  })
  const ids = campaigns.map((c) => c.id)

  const [states, eventRows] = await Promise.all([
    campaignBudgetStates(ids),
    ids.length === 0
      ? Promise.resolve([])
      : db.adEvent.groupBy({
          by: ['campaignId', 'eventType'],
          where: { campaignId: { in: ids } },
          _count: { _all: true },
        }),
  ])

  // counts[camelCase key][campaignId] → n
  const impressions = new Map<string, number>()
  const viewables = new Map<string, number>()
  const clicks = new Map<string, number>()
  for (const row of eventRows) {
    const n = row._count._all
    if (row.eventType === 'loaded_impression') impressions.set(row.campaignId, n)
    if (row.eventType === 'viewable_impression') viewables.set(row.campaignId, n)
    if (row.eventType === 'valid_click') clicks.set(row.campaignId, n)
  }

  return campaigns.map((c) => {
    const model = c.billingModel as BillingModel
    const imp = impressions.get(c.id) ?? 0
    const clk = clicks.get(c.id) ?? 0
    const spent = states.get(c.id)?.spentMicroUsd ?? 0
    return {
      campaignId: c.id,
      name: c.name,
      status: c.status,
      format: c.format,
      billingModel: model,
      bidLabel:
        model === 'cpc'
          ? `${(c.bidMicroUsd / 1_000_000).toFixed(2)} per click`
          : `${(c.bidMicroUsd / 1_000_000).toFixed(2)} per 1000 views`,
      impressions: imp,
      viewableImpressions: viewables.get(c.id) ?? 0,
      clicks: clk,
      ctr: imp > 0 ? clk / imp : null,
      spentMicroUsd: spent,
      ecpcMicroUsd: clk > 0 && spent > 0 ? Math.round(spent / clk) : null,
    }
  })
}
