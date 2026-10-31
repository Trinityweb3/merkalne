/**
 * Merklane Ads — the auction engine & reservation lifecycle (Phase 1).
 *
 * POOLS: eligible campaigns are split into a CPC and a CPM pool. When both
 * pools are non-empty the pool itself is chosen 50/50 (Phase 1 split);
 * within a pool the winner is drawn by weighted random on bidMicroUsd —
 * higher bid, proportionally higher probability (roulette wheel), the
 * "transparent auction" promised on the public page.
 *
 * ELIGIBILITY (per spec): campaigns with deletedAt ≠ null, status ≠ active,
 * or out of budget never enter the draw. "Out of budget" is derived from the
 * ledger — a campaign has no mutable balance column:
 *
 *   remaining = committed(|reserve| − refund) − spent(|charge|) − held
 *
 * plus the daily cap (dailyBudgetMicroUsd, 0 = none): today's charges plus
 * in-flight holds must still leave room for this event. Targeting — sections
 * + interface languages (Phase 1), contextual keywords, hashtags and the
 * visitor country (Phase 2) — filters against the serving page.
 *
 * BILLING — every billable event is a BudgetReservation (Phase 3: serving
 * NEVER charges):
 *
 *   Both models create the reservation HELD at serve time. The charge
 *   happens only when a VALIDATED client event finalises it:
 *
 *   CPC: serve → HELD for one bid (30-minute window). The visitor's click
 *        goes through the signed redirect route /api/ads/click/[token]:
 *        HMAC-validated, logged as a valid_click AdEvent, THEN charged.
 *        No valid click within 30 minutes → the sweeper expires the hold
 *        and the campaign budget recovers (the advertiser pays nothing).
 *   CPM: serve → HELD for bid/1000. <AdSlot/> measures viewability with the
 *        IntersectionObserver + Page Visibility API and beacons
 *        POST /api/ads/event after the ad has been ≥ 50 % visible for one
 *        continuous second in an active tab; the route verifies the HMAC
 *        token, logs the viewable_impression AdEvent and charges
 *        bid/1000. No viewable impression within the TTL → the hold
 *        expires, budget recovered, nothing charged.
 *
 *   Every serve also writes a loaded_impression AdEvent (server-side,
 *   atomic with the reservation creation) and mints the HMAC ad token
 *   that authenticates the later click/redirect and viewability beacon.
 *
 * DEDUPLICATION — a double click, a replayed beacon or a bot retrying the
 *   event can never charge twice, by three independent guards: (1) the
 *   conditional status flip below (held → finalized is atomic; the second
 *   fire finds a non-HELD row and no-ops), (2) the unique ledger eventId
 *   charge:<reservationId>, (3) the UNIQUE (reservationId, eventType) index
 *   on AdEvent. The wallet itself only ever moves through the conditional
 *   guards in src/lib/ads/wallet.ts (available ≥ X / reserved ≥ X).
 *
 * CONCURRENCY (Phase 1 model, kept): eligibility is re-read before every
 *   draw attempt, so a drained campaign stops being drawn. Two truly
 *   concurrent serves can over-commit a campaign by at most one in-flight
 *   event per serve — the 30-minute expiry self-heals it, and no money can
 *   ever be lost: every actual wallet movement goes through the conditional
 *   guards in src/lib/ads/wallet.ts, and every ledger posting is
 *   exactly-once via its unique eventId.
 */
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import type { Campaign } from '@prisma/client'
import { targetingMatches, type AdRequestContext } from '@/lib/ads/targeting'
import { chargeReservation } from '@/lib/ads/wallet'
import { perEventMicroUsd, type AdFormat, type BillingModel } from '@/lib/ads/money'
import { signAdToken } from '@/lib/ads/tokens'
import { logAdEvent } from '@/lib/ads/events'
import { truncateUserAgent, hashVisitorIp } from '@/lib/ads/antifraud'

export const AD_SLOT_IDS = ['home_banner', 'feed', 'article_bottom'] as const
export type AdSlotId = (typeof AD_SLOT_IDS)[number]

/** How long an unclicked CPC hold waits before expiring (spec: 30 minutes). */
export const RESERVATION_TTL_MS = 30 * 60 * 1000

export function adsEnabled(): boolean {
  return env.ADS_ENABLED
}

// ---------------------------------------------------------------------------
// Pure selection — exported for unit tests (scripts/test-ads-auction.ts)
// ---------------------------------------------------------------------------

export interface AuctionCandidate {
  id: string
  bidMicroUsd: number
}

export interface PoolCandidate extends AuctionCandidate {
  billingModel: BillingModel
}

/**
 * Roulette-wheel pick weighted by `bidMicroUsd`. Deterministic given the
 * candidates and the random point; pass `randomPoint ∈ [0, 1)` in tests,
 * omit it in production (crypto-strong random).
 */
export function pickWeightedRandom<T extends AuctionCandidate>(
  candidates: T[],
  randomPoint?: number,
): T | null {
  if (candidates.length === 0) return null
  const total = candidates.reduce((sum, c) => sum + Math.max(0, c.bidMicroUsd), 0)
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
    acc += Math.max(0, c.bidMicroUsd)
    if (x < acc) return c
  }
  return candidates[candidates.length - 1]
}

/**
 * Phase 1 pool split + in-pool weighted draw. When both pools are non-empty
 * the unit interval is cut in half: [0, 0.5) → CPC pool, [0.5, 1) → CPM
 * pool (50/50), and the point is re-scaled to [0, 1) inside the chosen
 * pool. With a single non-empty pool the point is used directly.
 */
export function pickPoolAndDraw<T extends PoolCandidate>(
  candidates: T[],
  randomPoint?: number,
): T | null {
  const cpc = candidates.filter((c) => c.billingModel === 'cpc' && c.bidMicroUsd > 0)
  const cpm = candidates.filter((c) => c.billingModel === 'cpm' && c.bidMicroUsd > 0)
  if (cpc.length === 0 && cpm.length === 0) return null

  let point: number
  if (randomPoint !== undefined) {
    point = randomPoint
  } else {
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    const frac = bytes.reduce((acc, b) => acc * 256 + b, 0) / 256 ** 6
    point = Math.min(frac, 0.999999)
  }

  if (cpc.length > 0 && cpm.length > 0) {
    return point < 0.5
      ? pickWeightedRandom(cpc, point * 2)
      : pickWeightedRandom(cpm, (point - 0.5) * 2)
  }
  if (cpc.length > 0) return pickWeightedRandom(cpc, point)
  return pickWeightedRandom(cpm, point)
}

// ---------------------------------------------------------------------------
// Ledger-derived budget state (there is no mutable balance column)
// ---------------------------------------------------------------------------

export interface CampaignBudgetState {
  campaignId: string
  /** Σ|reserve| − Σrefund — money currently committed to this campaign. */
  committedMicroUsd: number
  /** Σ|charge| — money spent on clicks/views. */
  spentMicroUsd: number
  /** Σ held reservations — in-flight, awaiting click/expiry. */
  heldMicroUsd: number
  /** Σ|charge| since UTC midnight. */
  spentTodayMicroUsd: number
  /** committed − spent − held. */
  remainingMicroUsd: number
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** Budget state for a set of campaigns, derived from the ledger + reservations. */
export async function campaignBudgetStates(
  campaignIds: string[],
  now: Date = new Date(),
  client: Pick<typeof db, 'ledgerEntry' | 'budgetReservation'> = db,
): Promise<Map<string, CampaignBudgetState>> {
  const map = new Map<string, CampaignBudgetState>(
    campaignIds.map((id) => [
      id,
      {
        campaignId: id,
        committedMicroUsd: 0,
        spentMicroUsd: 0,
        heldMicroUsd: 0,
        spentTodayMicroUsd: 0,
        remainingMicroUsd: 0,
      },
    ]),
  )
  if (campaignIds.length === 0) return map

  const [ledgerRows, todayRows, heldRows] = await Promise.all([
    client.ledgerEntry.groupBy({
      by: ['campaignId', 'type'],
      where: { campaignId: { in: campaignIds }, type: { in: ['reserve', 'refund', 'charge'] } },
      _sum: { amountMicroUsd: true },
    }),
    client.ledgerEntry.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: campaignIds }, type: 'charge', createdAt: { gte: startOfUtcDay(now) } },
      _sum: { amountMicroUsd: true },
    }),
    client.budgetReservation.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: campaignIds }, status: 'held' },
      _sum: { amountMicroUsd: true },
    }),
  ])

  for (const row of ledgerRows) {
    if (!row.campaignId) continue
    const state = map.get(row.campaignId)
    if (!state) continue
    const sum = row._sum.amountMicroUsd ?? 0
    // Signed storage: reserve/charge rows are negative, refund rows positive.
    if (row.type === 'reserve') state.committedMicroUsd += -sum
    if (row.type === 'refund') state.committedMicroUsd -= sum
    if (row.type === 'charge') state.spentMicroUsd += -sum
  }
  for (const row of todayRows) {
    if (!row.campaignId) continue
    const state = map.get(row.campaignId)
    if (state) state.spentTodayMicroUsd += -(row._sum.amountMicroUsd ?? 0)
  }
  for (const row of heldRows) {
    if (!row.campaignId) continue
    const state = map.get(row.campaignId)
    if (state) state.heldMicroUsd += row._sum.amountMicroUsd ?? 0
  }
  for (const state of map.values()) {
    state.remainingMicroUsd = state.committedMicroUsd - state.spentMicroUsd - state.heldMicroUsd
  }
  return map
}

// ---------------------------------------------------------------------------
// Reservation sweeper
// ---------------------------------------------------------------------------

/**
 * Flip every overdue HELD reservation (CPC, unclicked past its 30 minutes)
 * to EXPIRED — the held amount returns to the campaign's derived budget.
 * A single conditional statement; safe to call from serve / click / any
 * dashboard read.
 */
export async function expireStaleReservations(now: Date = new Date()): Promise<number> {
  const swept = await db.budgetReservation.updateMany({
    where: { status: 'held', expiresAt: { lt: now } },
    data: { status: 'expired' },
  })
  return swept.count
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const MAX_DRAW_ATTEMPTS = 4

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export interface ServedAd {
  campaignId: string
  /** The BudgetReservation id — the hold this serve created. */
  reservationId: string
  /** HMAC token authenticating the click redirect + viewability beacon. */
  clickToken: string
  format: AdFormat
  billingModel: BillingModel
  title: string | null
  body: string | null
  imageUrl: string | null
  /** Banner accessibility label (alt text). */
  altText: string | null
  targetUrl: string
  /** Advertiser's display domain, falling back to the target URL's host. */
  targetHost: string
  bidMicroUsd: number
}

/**
 * Serve one ad for a slot: eligibility → 50/50 pool split → weighted draw →
 * a HELD BudgetReservation (never a charge — Phase 3) + the server-side
 * loaded_impression event + the HMAC click/viewability token. `ctx` carries
 * the serving context (targeting dimensions + visitor UA/IP for the event
 * log); omit it to serve without targeting restrictions. Returns null when
 * ads are off or nothing is eligible.
 */
export async function serveAd(slot: string, ctx: AdRequestContext = {}): Promise<ServedAd | null> {
  if (!adsEnabled()) return null
  await expireStaleReservations()

  for (let attempt = 0; attempt < MAX_DRAW_ATTEMPTS; attempt++) {
    // Fresh read each attempt — this is the Phase 1 race guard (see the
    // header): a campaign drained by a concurrent serve stops being drawn.
    const campaigns = await db.campaign.findMany({
      where: { status: 'active', deletedAt: null },
      select: {
        id: true,
        advertiserId: true,
        format: true,
        billingModel: true,
        bidMicroUsd: true,
        dailyBudgetMicroUsd: true,
        targetSections: true,
        targetLocales: true,
        targetKeywords: true,
        keywordMatch: true,
        countryMode: true,
        targetCountries: true,
        targetHashtags: true,
        creatives: {
          where: { moderationStatus: 'approved' },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    })
    const states = await campaignBudgetStates(campaigns.map((c) => c.id))

    type Eligible = PoolCandidate & {
      campaign: (typeof campaigns)[number]
      state: CampaignBudgetState
      perEvent: number
    }
    const eligible: Eligible[] = []
    for (const c of campaigns) {
      const state = states.get(c.id)
      if (!state) continue
      const model = c.billingModel as BillingModel
      const perEvent = perEventMicroUsd(model, c.bidMicroUsd)
      if (perEvent <= 0) continue // non-cent-aligned CPM data — refuse to serve
      if (state.remainingMicroUsd < perEvent) continue // out of budget
      if (c.dailyBudgetMicroUsd > 0) {
        const dailyUsed = state.spentTodayMicroUsd + state.heldMicroUsd
        if (dailyUsed + perEvent > c.dailyBudgetMicroUsd) continue // daily cap reached
      }
      if (!targetingMatches(c, ctx)) continue
      if (c.creatives.length === 0) continue // nothing approved to render
      eligible.push({ id: c.id, bidMicroUsd: c.bidMicroUsd, billingModel: model, campaign: c, state, perEvent })
    }

    const drawn = pickPoolAndDraw(eligible)
    if (!drawn) return null
    const creative = drawn.campaign.creatives[0]
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS)

    // Phase 3 — BOTH models hold at serve time, NOTHING is charged here.
    // The charge lands only when a validated event finalises the hold (a
    // valid click through the signed redirect route for CPC; a viewable
    // impression beacon for CPM). Until then the hold just caps the
    // campaign's derived budget; if two concurrent serves over-commit, the
    // extra hold expires in 30 minutes and never charges anything.
    const reservation = await db.budgetReservation.create({
      data: { campaignId: drawn.id, amountMicroUsd: drawn.perEvent, status: 'held', expiresAt },
    })

    // The serve event itself: logged server-side, exactly once per hold.
    // This is the "Impressions" line of the advertiser reports — it cannot
    // be forged or missed by the client because the client is not involved.
    await logAdEvent({
      campaignId: drawn.id,
      reservationId: reservation.id,
      eventType: 'loaded_impression',
      slot,
      userAgent: truncateUserAgent(ctx.userAgent),
      ipHash: hashVisitorIp(ctx.visitorIp),
    })

    return toServedAd(drawn.campaign, creative, {
      reservationId: reservation.id,
      slot,
      expiresAt,
    })
  }
  return null
}

function toServedAd(
  campaign: Pick<Campaign, 'id' | 'format' | 'billingModel' | 'bidMicroUsd'>,
  creative: {
    title: string | null
    body: string | null
    imageUrl: string | null
    altText: string | null
    displayDomain: string | null
    targetUrl: string
  },
  hold: { reservationId: string; slot: string; expiresAt: Date },
): ServedAd {
  const billingModel = campaign.billingModel as BillingModel
  return {
    campaignId: campaign.id,
    reservationId: hold.reservationId,
    // The single signed token for this serve — it authenticates BOTH the
    // click redirect (/api/ads/click/[token]) and the viewability beacon
    // (POST /api/ads/event). exp == the reservation's 30-minute window:
    // after it the token still redirects honestly but never charges.
    clickToken: signAdToken({
      r: hold.reservationId,
      c: campaign.id,
      m: billingModel,
      u: creative.targetUrl,
      s: hold.slot,
      exp: hold.expiresAt.getTime(),
    }),
    format: campaign.format as AdFormat,
    billingModel,
    title: creative?.title ?? null,
    body: creative?.body ?? null,
    imageUrl: creative?.imageUrl ?? null,
    altText: creative?.altText ?? null,
    targetUrl: creative.targetUrl,
    // The advertiser's friendly display domain wins; the real destination
    // host is the fallback (and the redirect always goes to the honest
    // signed targetUrl — never to the display domain).
    targetHost: creative?.displayDomain?.trim() || hostOf(creative.targetUrl),
    bidMicroUsd: campaign.bidMicroUsd,
  }
}

// ---------------------------------------------------------------------------
// Billing events — the ONLY places a wallet charge can ever happen
// ---------------------------------------------------------------------------

/**
 * Finalise a HELD reservation: conditional status flip (held → finalized
 * inside the 30-minute window) followed by the wallet charge, in ONE
 * transaction. Double fires / replays settle to a single charge: the second
 * caller finds the row non-HELD and gets not_held; the unique ledger
 * eventId `charge:<reservationId>` is the second line of defence.
 */
async function finalizeHeld(
  reservationId: string,
  expectedModel: BillingModel,
): Promise<
  | { ok: true; chargedMicroUsd: number }
  | { ok: false; reason: 'not_held' | 'wrong_model' | 'invariant_broken' }
> {
  const now = new Date()
  try {
    return await db.$transaction(async (tx) => {
      const reservation = await tx.budgetReservation.findUnique({ where: { id: reservationId } })
      if (!reservation) return { ok: false as const, reason: 'not_held' as const }
      const campaign = await tx.campaign.findUnique({
        where: { id: reservation.campaignId },
        select: { advertiserId: true, billingModel: true },
      })
      if (!campaign) return { ok: false as const, reason: 'not_held' as const }

      // Defence in depth: the signed ad token already says which billing
      // model this event is billable for — the database must agree before
      // any money moves (a CPM view can never charge a CPC campaign and
      // vice versa, whatever a crafted token claims).
      if ((campaign.billingModel as BillingModel) !== expectedModel) {
        return { ok: false as const, reason: 'wrong_model' as const }
      }

      const flip = await tx.budgetReservation.updateMany({
        where: { id: reservationId, status: 'held', expiresAt: { gt: now } },
        data: { status: 'finalized' },
      })
      if (flip.count !== 1) return { ok: false as const, reason: 'not_held' as const }

      const charged = await chargeReservation(tx, {
        userId: campaign.advertiserId,
        campaignId: reservation.campaignId,
        reservationId: reservation.id,
        amountMicroUsd: reservation.amountMicroUsd,
      })
      if (!charged.ok) throw new Error('ledger invariant broken while charging a billing event')
      return { ok: true as const, chargedMicroUsd: reservation.amountMicroUsd }
    })
  } catch {
    return { ok: false, reason: 'invariant_broken' }
  }
}

/**
 * A valid click on a served CPC ad (the only CPC billing event). Called by
 * the signed redirect route /api/ads/click/[token] AFTER the token's HMAC
 * and expiry were verified. A CPM reservation handed here is refused
 * (wrong_model): CPM bills views, never clicks.
 */
export async function finalizeClick(
  reservationId: string,
): Promise<
  | { ok: true; chargedMicroUsd: number }
  | { ok: false; reason: 'not_held' | 'wrong_model' | 'invariant_broken' }
> {
  return finalizeHeld(reservationId, 'cpc')
}

/**
 * A valid viewable impression on a served CPM ad (the only CPM billing
 * event). Called by the event route /api/ads/event after <AdSlot/> measured
 * ≥ 50 % visibility for one continuous second in an active tab and the
 * token's HMAC + expiry were verified. A CPC reservation handed here is
 * refused (wrong_model): CPC bills clicks, never views.
 */
export async function finalizeView(
  reservationId: string,
): Promise<
  | { ok: true; chargedMicroUsd: number }
  | { ok: false; reason: 'not_held' | 'wrong_model' | 'invariant_broken' }
> {
  return finalizeHeld(reservationId, 'cpm')
}

// ---------------------------------------------------------------------------
// Campaign stats (dashboard)
// ---------------------------------------------------------------------------

export interface CampaignStats {
  /** All reservations ever (any status) — for a CPC campaign this is "served". */
  reservations: number
  /** Finalised reservations — CPC clicks / CPM views. */
  finalized: number
  /** Currently in-flight holds. */
  held: number
  heldMicroUsd: number
  spentMicroUsd: number
  committedMicroUsd: number
  remainingMicroUsd: number
}

/**
 * Per-campaign delivery stats for the advertiser dashboard. Budget figures
 * come from the ledger (campaignBudgetStates); counts come from the
 * reservation table grouped by status.
 */
export async function campaignStats(campaignIds: string[]): Promise<Map<string, CampaignStats>> {
  const states = await campaignBudgetStates(campaignIds)
  const map = new Map<string, CampaignStats>(
    campaignIds.map((id) => [
      id,
      {
        reservations: 0,
        finalized: 0,
        held: 0,
        heldMicroUsd: states.get(id)?.heldMicroUsd ?? 0,
        spentMicroUsd: states.get(id)?.spentMicroUsd ?? 0,
        committedMicroUsd: states.get(id)?.committedMicroUsd ?? 0,
        remainingMicroUsd: states.get(id)?.remainingMicroUsd ?? 0,
      },
    ]),
  )
  if (campaignIds.length === 0) return map

  const rows = await db.budgetReservation.groupBy({
    by: ['campaignId', 'status'],
    where: { campaignId: { in: campaignIds } },
    _count: { _all: true },
  })
  for (const row of rows) {
    const entry = map.get(row.campaignId)
    if (!entry) continue
    const n = row._count._all
    entry.reservations += n
    if (row.status === 'finalized') entry.finalized += n
    if (row.status === 'held') entry.held += n
  }
  return map
}
