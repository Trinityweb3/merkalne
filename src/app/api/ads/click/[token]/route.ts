import { db } from '@/lib/db'
import { handleRouteError, jsonError } from '@/lib/api'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { finalizeClick } from '@/lib/ads/auction'
import { verifyAdToken, isTokenExpired } from '@/lib/ads/tokens'
import { logAdEvent } from '@/lib/ads/events'
import { isKnownBot, truncateUserAgent, hashVisitorIp } from '@/lib/ads/antifraud'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads/click/[token] — the SECURE REDIRECT ROUTE (Phase 3).
 *
 * A click on a served ad no longer opens the destination directly: the
 * rendered card's href points HERE, carrying the serve's HMAC token. The
 * route, in order:
 *
 *   1. verifies the HMAC signature (unforgeable; minted at serve time) —
 *      a bad signature is a plain 400, never a redirect;
 *   2. rate-limits per IP (a rate-limited click still redirects — the
 *      destination is genuine, only the accounting is skipped);
 *   3. skips ALL billing + logging for known bots (they still get the
 *      redirect: the destination is the advertiser's signed URL, but a
 *      bot can never generate a billable event);
 *   4. for an in-window token: logs the valid_click AdEvent (exactly once
 *      — the UNIQUE (reservationId, eventType) index settles double clicks
 *      and bot retries to a single row) and, for a CPC campaign, finalises
 *      the HELD BudgetReservation — the ONLY place a CPC wallet charge can
 *      ever happen (conditional status flip + unique ledger eventId, so a
 *      replayed link can never double-charge);
 *   5. 302-redirects to the signed https destination.
 *
 * An EXPIRED-but-signed token (clicked after the 30-minute window) still
 * redirects honestly — the visitor sees the advertiser's site — but is no
 * longer billable: no charge, no valid_click row. CPM tokens never charge
 * here (CPM bills viewable impressions); their clicks are logged as
 * informational valid_click events so CTR is reported for both models.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params

    // 1 — signature first: a forged token must never reach the DB (and can
    // never choose its own redirect target).
    const payload = verifyAdToken(token)
    if (!payload) {
      return jsonError('This ad link is not valid.', 400, { code: 'bad_token' })
    }

    // 2 — per-IP accounting limit. A burst past it still redirects (a real
    // visitor must reach the advertiser's site) but skips the bookkeeping.
    const ip = clientIp(req)
    const rl = rateLimit(`ads-click:${ip}`, 30, 60_000)
    const userAgent = req.headers.get('user-agent')

    // 3 — bots: redirect, never bill, never log.
    if (!rl.ok || isKnownBot(userAgent) || isTokenExpired(payload)) {
      return redirect(payload.u)
    }

    // 4 — in-window human click on a live reservation. The lookup is by the
    // token's own reservation id; paranoia: the signed campaign id must match
    // the row (a mismatch can only be a swept/re-created id — treat as a
    // plain redirect, no accounting).
    const reservation = await db.budgetReservation.findUnique({
      where: { id: payload.r },
      select: { id: true, campaignId: true, status: true },
    })
    if (!reservation || reservation.campaignId !== payload.c) {
      return redirect(payload.u)
    }

    // CPC: the only CPC billing event — held → finalized (+ CHARGE ledger
    // row). Duplicate clicks find the row already finalized and no-op.
    if (payload.m === 'cpc' && reservation.status === 'held') {
      await finalizeClick(payload.r)
    }

    // Both models log the click — CPM clicks are informational (CPM bills
    // views, not clicks) but CTR is reported for every campaign. Replays
    // resolve to duplicate:true on the unique index: one row, one charge.
    // An EXPIRED row never counts: that click was not a valid one.
    if (reservation.status !== 'expired') {
      await logAdEvent({
        campaignId: payload.c,
        reservationId: payload.r,
        eventType: 'valid_click',
        slot: payload.s,
        userAgent: truncateUserAgent(userAgent),
        ipHash: hashVisitorIp(ip),
      })
    }

    // 5 — the honest destination.
    return redirect(payload.u)
  } catch (err) {
    return handleRouteError(err)
  }
}

/** 302 to the signed destination (never anything else). */
function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } })
}
