/**
 * Merklane Ads Phase 3 — HMAC-signed ad tokens.
 *
 * Every served ad carries ONE signed token (minted server-side when the
 * BudgetReservation is created). The SAME token authenticates both
 * billable client interactions:
 *
 *   • the click href — /api/ads/click/[token] — the secure redirect route
 *     validates the HMAC, finalises the CPC reservation (charge), logs the
 *     valid_click event and 302-redirects to the advertiser's destination;
 *   • the viewability beacon — POST /api/ads/event { token, type:
 *     'viewable_impression' } — fired by <AdSlot/> after the ad has been
 *     ≥ 50 % visible for one continuous second in an active tab; the route
 *     validates the HMAC and finalises the CPM reservation (charge).
 *
 * Wire format: `base64url(compact JSON) + '.' + base64url(HMAC-SHA256)`,
 * the same shape as the OAuth state tokens in src/lib/csrf.ts.
 *
 * The payload carries everything the routes need WITHOUT another DB read
 * being authoritative: reservation id, campaign id, billing model, the
 * https destination, the placement and the reservation's expiry (unix ms).
 * A token can only be minted by the serve path; the HMAC makes it
 * unforgeable, so a crafted beacon can never charge a campaign it was
 * never served for. `exp` is part of the signed payload — an expired token
 * is still SIGNATURE-valid (the destination is genuine, the visitor still
 * gets redirected) but no longer billable: the routes check the expiry
 * and the reservation's conditional status flip before any charge.
 */
import crypto from 'node:crypto'
import { adsEventSecret } from '@/lib/env'
import type { BillingModel } from '@/lib/ads/money'

export interface AdTokenPayload {
  /** BudgetReservation id — the in-flight hold this token settles. */
  r: string
  /** Campaign id. */
  c: string
  /** Billing model — decides which events are billable. */
  m: BillingModel
  /** The https destination a validated click redirects to. */
  u: string
  /** Placement id ("home_banner" | "feed" | "article_bottom"). */
  s: string
  /** Reservation expiry, unix milliseconds (the 30-minute window). */
  exp: number
}

/** Byte length guards — a token is small by construction; refuse junk. */
const MIN_TOKEN_LEN = 24
const MAX_TOKEN_LEN = 2048

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

function hmacBase64url(value: string): string {
  return crypto.createHmac('sha256', adsEventSecret).update(value).digest('base64url')
}

/** Constant-time string compare (same helper idea as csrf.ts). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/**
 * Mint a token for a served ad. Pure: the payload is fully supplied by the
 * caller (the auction engine, which just created the reservation).
 */
export function signAdToken(payload: AdTokenPayload): string {
  const body = b64url(JSON.stringify(payload))
  return `${body}.${hmacBase64url(body)}`
}

/**
 * Verify a token's signature and shape. Returns the payload, or null for
 * anything malformed/unsigned. Expiry is NOT judged here — callers decide
 * what an expired-but-signed token may still do (redirect, never charge);
 * see isTokenExpired().
 */
export function verifyAdToken(token: string): AdTokenPayload | null {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LEN || token.length > MAX_TOKEN_LEN) {
    return null
  }
  const dot = token.lastIndexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (!safeEqual(sig, hmacBase64url(body))) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Partial<AdTokenPayload>
  if (
    typeof p.r !== 'string' || !p.r ||
    typeof p.c !== 'string' || !p.c ||
    (p.m !== 'cpc' && p.m !== 'cpm') ||
    typeof p.u !== 'string' || !/^https:\/\//.test(p.u) ||
    typeof p.s !== 'string' || !p.s ||
    typeof p.exp !== 'number' || !Number.isFinite(p.exp)
  ) {
    return null
  }
  return p as AdTokenPayload
}

/** True when the token's signed expiry is in the past. */
export function isTokenExpired(payload: AdTokenPayload, now: number = Date.now()): boolean {
  return now > payload.exp
}
