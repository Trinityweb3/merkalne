import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited } from '@/lib/api'
import { assertSameOrigin } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { finalizeView } from '@/lib/ads/auction'
import { verifyAdToken, isTokenExpired } from '@/lib/ads/tokens'
import { logAdEvent } from '@/lib/ads/events'
import { isKnownBot, truncateUserAgent, hashVisitorIp } from '@/lib/ads/antifraud'

export const dynamic = 'force-dynamic'

/** Viewability beacon budget: 30 events / minute / IP (a full page fires ≤ 6). */
const EVENT_RATE_LIMIT = 30
const EVENT_RATE_WINDOW_MS = 60_000

const beaconSchema = z.object({
  /** The serve's HMAC ad token (same token as the click href). */
  token: z.string().min(24).max(2048),
  /** Only viewability is client-reported today. */
  type: z.literal('viewable_impression'),
})

/**
 * POST /api/ads/event — the VIEWABILITY BEACON endpoint (Phase 3).
 *
 * <AdSlot/> fires this after measuring, with the IntersectionObserver and
 * the Page Visibility API, that the ad was at least 50 % visible for ONE
 * CONTINUOUS SECOND in an active tab. The server never trusts that claim
 * on its own — a beacon is only accepted when it carries a valid HMAC ad
 * token (minted at serve time, unforgeable) whose 30-minute window is
 * still open.
 *
 * Billing (Task 2 of the Phase 3 spec):
 *   • CPM — a validated viewable impression is the ONLY CPM billing event:
 *     the HELD reservation is finalised (held → finalized) and the wallet
 *     is charged bid/1000. No valid beacon within the TTL → the sweeper
 *     expires the hold and the budget is refunded to the campaign.
 *   • CPC — views are never billed (CPC charges clicks only, on the signed
 *     redirect route); the beacon is still LOGGED as an informational
 *     viewable_impression so the Reports tab can show viewability for
 *     every campaign.
 *
 * Anti-fraud (Task 3):
 *   • same-origin only (the beacon comes from our own pages);
 *   • 30 events / minute / IP — a burst past it is a 429;
 *   • known bots/crawlers are refused with 403 — they can never generate
 *     a billable event;
 *   • duplicate beacons (double render, retry, bot replay) are idempotent
 *     no-ops: { recorded: false, reason: 'duplicate' } and NO second
 *     charge (conditional status flip + unique ledger eventId + the
 *     AdEvent unique index).
 */
export async function POST(req: Request) {
  try {
    // Same-origin: the beacon is a browser POST from our own pages.
    assertSameOrigin(req)

    const ip = clientIp(req)
    const rl = rateLimit(`ads-event:${ip}`, EVENT_RATE_LIMIT, EVENT_RATE_WINDOW_MS)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const userAgent = req.headers.get('user-agent')
    if (isKnownBot(userAgent)) {
      return jsonError('Automated traffic cannot generate billable ad events.', 403, { code: 'bot' })
    }

    const parsed = beaconSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return jsonError('Invalid beacon payload.', 400, { code: 'bad_beacon' })

    // Signature first: a forged beacon must never reach the database.
    const payload = verifyAdToken(parsed.data.token)
    if (!payload) return jsonError('This ad token is not valid.', 400, { code: 'bad_token' })

    // An honestly-signed but out-of-window token: idempotent no-op. The
    // visitor left the tab open past the 30-minute hold — nothing is due.
    if (isTokenExpired(payload)) {
      return jsonOk({ recorded: false, reason: 'expired' })
    }

    const reservation = await db.budgetReservation.findUnique({
      where: { id: payload.r },
      select: { id: true, campaignId: true, status: true, expiresAt: true },
    })
    // Paranoia: the signed campaign id must match the row (a mismatch can
    // only be a swept/re-created id — refuse, never charge).
    if (!reservation || reservation.campaignId !== payload.c) {
      return jsonError('This ad token is not valid.', 400, { code: 'bad_token' })
    }
    // The row may already be past its window even though the token is not
    // (ms skew, or a sweeper run a moment ago): same honest answer.
    if (reservation.expiresAt.getTime() <= Date.now() || reservation.status === 'expired') {
      return jsonOk({ recorded: false, reason: 'expired' })
    }
    // Already settled by an earlier beacon (or, for CPC, by nothing — CPC
    // rows are only finalised by clicks, but a re-rendered beacon must
    // still not double-log).
    if (reservation.status === 'finalized') {
      return jsonOk({ recorded: false, reason: 'duplicate' })
    }

    // CPM: the only CPM billing event — finalise + charge. A concurrent
    // twin loses the conditional flip and lands on 'duplicate' above / the
    // not_held branch inside; either way exactly one charge happens.
    let chargedMicroUsd = 0
    if (payload.m === 'cpm') {
      const result = await finalizeView(payload.r)
      if (!result.ok) return jsonOk({ recorded: false, reason: 'duplicate' })
      chargedMicroUsd = result.chargedMicroUsd
    }

    const logged = await logAdEvent({
      campaignId: payload.c,
      reservationId: payload.r,
      eventType: 'viewable_impression',
      slot: payload.s,
      userAgent: truncateUserAgent(userAgent),
      ipHash: hashVisitorIp(ip),
    })
    if (!logged.ok) return jsonError('Invalid beacon payload.', 400, { code: 'bad_beacon' })

    return jsonOk({ recorded: true, chargedMicroUsd })
  } catch (err) {
    return handleRouteError(err)
  }
}
