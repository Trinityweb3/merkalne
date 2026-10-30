/**
 * Tracking helpers for the anonymous page-view beacon (POST /api/track).
 *
 * Runtime-agnostic (worker + Next routes) — no `server-only`, no `next/*`.
 * PRIVACY: the beacon stores an irreversible HMAC fingerprint of ip+user-agent
 * and a proxy-header country code. Never a raw IP, never a user id.
 */
import { createHmac } from 'node:crypto'
import { POST_SECTIONS } from '../constants'

/** Obvious crawler/spider/lighthouse user agents — never counted as visitors. */
const BOT_UA_RE = /\b(bot|crawler|spider|crawling|headless|lighthouse|pagespeed|curl|wget|python-requests|facebookexternalhit|preview)\b/i

/**
 * Proxy headers that carry a 2-letter country code, in priority order.
 * cf-ipcountry comes FIRST: Cloudflare sets it on EVERY proxied request
 * (based on the connection's geo data at the edge) and it survives local
 * reverse proxies like Caddy, which only rewrite X-Forwarded-For.
 */
const COUNTRY_HEADERS = [
  'cf-ipcountry', // Cloudflare (works out of the box when fronted by CF)
  'x-vercel-ip-country',
  'x-geo-country',
  'x-country-code',
] as const

export const UNKNOWN_COUNTRY = 'XX'

/** True when the user agent is a known automation/crawler client. */
export function isBotUserAgent(ua: string): boolean {
  return BOT_UA_RE.test(ua)
}

/**
 * Country from standard proxy geo headers (upper-cased 2-letter ISO code).
 *
 * Cloudflare special values in cf-ipcountry are handled explicitly:
 *   "XX" — CF could not determine the visitor's country
 *   "T1" — Tor exit node (not a country; Intl.DisplayNames can't label it)
 * Both fall through to the remaining headers instead of masking a real
 * country a later proxy might still provide, and degrade to XX (unknown)
 * only when nothing usable is present. Self-hosted setups without a
 * geo-aware proxy honestly report unknown instead of guessing.
 *
 * VPN users are counted at the VPN exit node's country on purpose — this is
 * statistics, not access control.
 */
export function countryFromHeaders(headers: Headers): string {
  for (const name of COUNTRY_HEADERS) {
    const raw = headers.get(name)
    if (!raw) continue
    const code = raw.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(code)) continue // T1, garbage, multi-token — skip
    if (code === UNKNOWN_COUNTRY) continue // CF "unknown" — try other sources
    return code
  }
  return UNKNOWN_COUNTRY
}

/**
 * Stable, non-reversible visitor fingerprint: HMAC-SHA256(ip + user-agent),
 * truncated to 32 hex chars. Two requests from the same visitor hash the same,
 * while a database leak reveals nothing reversible. Uses AUTH_SECRET when set
 * (read directly from process.env — this module must stay worker-importable,
 * so it cannot import the server-only env.ts).
 */
export function visitorFingerprint(ip: string, userAgent: string): string {
  const secret = process.env.AUTH_SECRET || 'merklane-dev-stats-secret'
  return createHmac('sha256', secret).update(`${ip}|${userAgent}`).digest('hex').slice(0, 32)
}

/** Map a page path to the section bucket used by the stats aggregation. */
export function deriveSection(path: string): string {
  let clean = path.split('?')[0].split('#')[0]
  // Locale-prefixed paths (/ru/markets, /ar/about…) bucket with the default
  // locale: strip a leading /{locale} for any non-default interface language.
  const localeMatch = clean.match(/^\/(ru|uk|hi|zh|fa|ar|bn|es|pt|fr|de|ko|ja|id|fil|th|vi|tr|ur)(?=\/|$)/)
  if (localeMatch) clean = clean.slice(localeMatch[0].length) || '/'
  const segments = clean.split('/').filter(Boolean)

  if (segments.length === 0) return 'home'

  const [first] = segments
  if ((POST_SECTIONS as readonly string[]).includes(first)) return first

  // Non-content pages get their own bucket so section stats stay meaningful.
  const PAGE_SECTIONS = new Set([
    'about', 'search', 'premium', 'recruiter', 'ads', 'auth', 'profile',
    'alerts', 'contact', 'privacy', 'terms', 'cookies', 'risk',
  ])
  if (PAGE_SECTIONS.has(first)) return first
  return 'other'
}

/** Beacon payloads must be first-party page paths — never APIs or static files. */
export function isValidTrackPath(path: string): boolean {
  if (!path.startsWith('/') || path.length > 512) return false
  if (path.startsWith('/api') || path.startsWith('/_next')) return false
  // anything with a file extension (favicon.svg, logo.svg, …) is not a page
  if (/\.[A-Za-z0-9]{1,8}$/.test(path)) return false
  return true
}
