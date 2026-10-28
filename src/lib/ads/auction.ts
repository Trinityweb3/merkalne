/**
 * Merklane Ads — the weighted-random auction engine.
 *
 * When a slot asks for an ad, every ACTIVE campaign with a remaining balance
 * ≥ its bid enters the draw. The probability of being picked is proportional
 * to `bidPerView` (roulette-wheel selection): a $0.02 campaign is picked
 * twice as often as a $0.01 one. This keeps inventory distributed across
 * advertisers (no pure pay-to-win starvation) while letting higher bids buy
 * more share — the "transparent auction" promised on the public page.
 *
 * Billing is atomic per impression: the balance decrement is a conditional
 * `updateMany` (`WHERE balance >= bid`), so two concurrent slot requests can
 * never overdraw a campaign — the loser of the race simply re-draws. When the
 * balance drains to 0 the campaign is auto-paused (resumable after a top-up).
 */
import { db } from '@/lib/db'
import { env } from '@/lib/env'

export const AD_SLOT_IDS = ['home_banner', 'feed', 'article_bottom'] as const
export type AdSlotId = (typeof AD_SLOT_IDS)[number]

export interface AuctionCandidate {
  id: string
  bidPerView: number
}

export interface ServedAd {
  campaignId: string
  impressionId: string
  title: string
  body: string
  ctaUrl: string
  ctaLabel: string | null
  /** Display host, e.g. "acme.xyz" — shown on the card for transparency. */
  ctaHost: string
  bidPerView: number
}

/** True when ad serving is switched on (ADS_ENABLED, default on). */
export function adsEnabled(): boolean {
  return env.ADS_ENABLED
}

// ---------------------------------------------------------------------------
// Pure selection — exported for unit tests (scripts/test-ads-auction.ts)
// ---------------------------------------------------------------------------

/**
 * Roulette-wheel pick weighted by `bidPerView`. Deterministic given the
 * candidates and the random point; pass `randomPoint ∈ [0, 1)` in tests,
 * omit it in production (crypto-strong random).
 */
export function pickWeightedRandom<T extends AuctionCandidate>(
  candidates: T[],
  randomPoint?: number,
): T | null {
  if (candidates.length === 0) return null
  const total = candidates.reduce((sum, c) => sum + Math.max(0, c.bidPerView), 0)
  if (total <= 0) return null

  let point: number
  if (randomPoint !== undefined) {
    point = randomPoint
  } else {
    // 48 bits of crypto entropy — far more resolution than the weights need.
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    const frac = bytes.reduce((acc, b) => acc * 256 + b, 0) / 256 ** 6
    point = Math.min(frac, 0.999999)
  }
  const x = point * total

  let acc = 0
  for (const c of candidates) {
    acc += Math.max(0, c.bidPerView)
    if (x < acc) return c
  }
  return candidates[candidates.length - 1]
}

// ---------------------------------------------------------------------------
// Serving (atomic bill + impression ledger)
// ---------------------------------------------------------------------------

const MAX_DRAW_ATTEMPTS = 4

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Serve one ad for a slot: draw → atomically deduct the bid → write the
 * "view" ledger row. Returns null when ads are off, no campaign is eligible
 * or every drawn campaign lost the balance race (rare).
 */
export async function serveAd(_slot: string): Promise<ServedAd | null> {
  if (!adsEnabled()) return null

  const candidates = await db.adCampaign.findMany({
    where: { status: 'active', balance: { gte: 1 } },
    select: { id: true, bidPerView: true, balance: true },
  })
  // Only campaigns whose balance still covers their own bid enter the wheel.
  const eligible = candidates
    .filter((c) => c.bidPerView >= 1 && c.balance >= c.bidPerView)
    .map((c) => ({ id: c.id, bidPerView: c.bidPerView }))

  for (let attempt = 0; attempt < MAX_DRAW_ATTEMPTS; attempt++) {
    const drawn = pickWeightedRandom(eligible)
    if (!drawn) return null

    // Atomic bill: succeeds only while the balance still covers the bid.
    // A concurrent request that drained it first makes count 0 → re-draw.
    const billed = await db.adCampaign.updateMany({
      where: { id: drawn.id, status: 'active', balance: { gte: drawn.bidPerView } },
      data: { balance: { decrement: drawn.bidPerView } },
    })
    if (billed.count !== 1) continue

    const campaign = await db.adCampaign.findUnique({
      where: { id: drawn.id },
      select: { title: true, body: true, ctaUrl: true, ctaLabel: true, balance: true },
    })
    if (!campaign) continue

    // Balance exhausted → auto-pause (advertiser resumes after a top-up).
    if (campaign.balance <= 0) {
      await db.adCampaign
        .update({ where: { id: drawn.id }, data: { status: 'paused' } })
        .catch(() => undefined)
    }

    const impression = await db.adImpression.create({
      data: { campaignId: drawn.id, type: 'view' },
    })

    return {
      campaignId: drawn.id,
      impressionId: impression.id,
      title: campaign.title,
      body: campaign.body,
      ctaUrl: campaign.ctaUrl,
      ctaLabel: campaign.ctaLabel,
      ctaHost: hostOf(campaign.ctaUrl),
      bidPerView: drawn.bidPerView,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Clicks (never billed — the view already paid)
// ---------------------------------------------------------------------------

/**
 * Record a click on a served impression. The AdSlot client fires this once
 * per rendered ad; the server re-checks that the impression exists and was a
 * view, and rate-limits per impression id so double-fires settle to one row.
 */
export async function recordClick(impressionId: string): Promise<{ ok: boolean }> {
  const view = await db.adImpression.findUnique({ where: { id: impressionId } })
  if (!view || view.type !== 'view') return { ok: false }
  await db.adImpression.create({ data: { campaignId: view.campaignId, type: 'click' } })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Campaign stats (dashboard)
// ---------------------------------------------------------------------------

export interface CampaignStats {
  impressions: number
  clicks: number
}

/** Per-campaign view/click counts for the advertiser dashboard. */
export async function campaignStats(campaignIds: string[]): Promise<Map<string, CampaignStats>> {
  const map = new Map<string, CampaignStats>(
    campaignIds.map((id) => [id, { impressions: 0, clicks: 0 }]),
  )
  if (campaignIds.length === 0) return map
  const rows = await db.adImpression.groupBy({
    by: ['campaignId', 'type'],
    where: { campaignId: { in: campaignIds } },
    _count: { _all: true },
  })
  for (const row of rows) {
    const entry = map.get(row.campaignId)
    if (!entry) continue
    if (row.type === 'view') entry.impressions = row._count._all
    if (row.type === 'click') entry.clicks = row._count._all
  }
  return map
}
