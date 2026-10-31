/**
 * Merklane Ads Phase 3 — basic anti-fraud for the event pipeline.
 *
 * Two layers in front of the billable events (serve / viewability beacon /
 * click redirect):
 *
 *   1. BOT FILTER — src/lib/ads/antifraud.ts (this file): known bots and
 *      crawlers are detected from the User-Agent and NEVER generate
 *      billable events. Bots get no ad served at all (the serve route
 *      answers 204 before the auction runs, so no BudgetReservation is
 *      ever created for them); a bot hitting the click route is redirected
 *      (the destination is the advertiser's genuine, signed URL) but never
 *      charged and never logged as a valid click; a bot posting to the
 *      event endpoint is rejected with 403.
 *
 *      UA sniffing is deliberately BASIC (the spec says so): it stops
 *      casual scrapers, RSS readers and honest crawlers from burning
 *      advertiser budgets. A determined attacker with a real browser UA
 *      is handled by the OTHER rails — the HMAC ad token (only real serves
 *      mint one), the exactly-once AdEvent unique index, the conditional
 *   reservation status flip and the per-IP rate limits.
 *
 *   2. RATE LIMITS — the in-process sliding window from src/lib/rate-limit.
 *      The event endpoint allows 30 beacons / minute / IP (a page with all
 *   three placements fires at most ~6 events per view), the serve and
 *      click routes keep their existing per-IP limits.
 *
 * This module is nearly PURE (the only dependency is the env secret for the
 * visitor-IP hash) so it can be unit-tested and imported from both the route
 * handlers and the auction engine.
 */
import crypto from 'node:crypto'
import { adsEventSecret } from '@/lib/env'

/** Truncation for the UA stored on AdEvent rows (analytics only). */
const UA_STORE_CAP = 180

/**
 * Known bot / crawler / tooling tokens, matched case-insensitively against
 * the whole User-Agent. Ordered roughly by family: search crawlers, SEO
 * scrapers, AI fetchers, link checkers, uptime monitors, HTTP libraries,
 * scripted browsers.
 */
const BOT_TOKENS: readonly string[] = [
  // search & content crawlers
  'googlebot', 'bingbot', 'slurp', 'duckduckbot', 'baiduspider', 'yandex',
  'sogou', 'exabot', 'petalbot', 'bytespider', 'applebot', 'ia_archiver',
  // social / chat previews
  'facebookexternalhit', 'facebot', 'twitterbot', 'linkedinbot',
  'pinterestbot', 'slackbot', 'discordbot', 'telegrambot', 'whatsapp',
  // AI fetchers
  'gptbot', 'chatgpt-user', 'oai-searchbot', 'ccbot', 'claudebot',
  'claude-web', 'anthropic-ai', 'perplexitybot', 'google-read-aloud',
  // SEO / backlink scrapers
  'semrushbot', 'ahrefsbot', 'mj12bot', 'dotbot', 'rogerbot', 'screaming',
  'majestic', 'backlinks', 'serpstatbot', 'dataforseo', 'openlinkprofiler',
  // generic crawler vocabulary
  'bot', 'crawl', 'spider', 'scrap', 'slurp', 'fetcher', 'archiver',
  'monitoring', 'uptime', 'pingdom', 'statuscake', 'hetrix', 'betteruptime',
  // scripted browsers & automation
  'headlesschrome', 'phantomjs', 'selenium', 'puppeteer', 'playwright',
  'nightmarejs', 'cypress',
  // HTTP libraries & CLI tools (no real browser sends these)
  'python-requests', 'python-urllib', 'httpx', 'curl/', 'wget',
  'scrapy', 'go-http-client', 'java/', 'okhttp', 'apache-httpclient',
  'node-fetch', 'axios/', 'postmanruntime', 'httpclient', 'libwww',
  'http-client', 'lwp-', 'zgrab', 'nmap', 'masscan', 'nikto', 'sqlmap',
  'rss', 'feedfetcher', 'feedparser',
]

/**
 * True when the User-Agent identifies a known bot/crawler/tool. A missing
 * or blank UA (curl -A "" and friends, raw sockets) is treated as a bot
 * too: no real browser ever omits it.
 */
export function isKnownBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? '').trim()
  if (!ua) return true
  const lower = ua.toLowerCase()
  return BOT_TOKENS.some((token) => lower.includes(token))
}

/**
 * User-Agent trimmed for AdEvent storage (analytics only) — collapsed
 * whitespace, capped. Returns null for an absent UA.
 */
export function truncateUserAgent(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? '').trim().replace(/\s+/g, ' ')
  if (!ua) return null
  return ua.length > UA_STORE_CAP ? ua.slice(0, UA_STORE_CAP) : ua
}

// ---------------------------------------------------------------------------
// Anonymised visitor fingerprint (for the AdEvent anti-fraud columns)
// ---------------------------------------------------------------------------

/**
 * Salted, truncated SHA-256 of the visitor IP — what AdEvent.ipHash stores.
 * The raw IP is NEVER persisted (same policy as the anonymous stats
 * fingerprint); the salt is the ads event secret, so the hash cannot be
 * reversed against a public rainbow table. 16 hex chars is plenty to link
 * the events of one visit together for fraud review.
 */
export function hashVisitorIp(ip: string | null | undefined): string | null {
  const value = (ip ?? '').trim()
  if (!value || value === 'unknown') return null
  return crypto
    .createHash('sha256')
    .update(`${value}:${adsEventSecret}`)
    .digest('hex')
    .slice(0, 16)
}

// ---------------------------------------------------------------------------
// Stable visitor identity (Phase 4 — A/B assignment input)
// ---------------------------------------------------------------------------

/**
 * The STABLE visitor id used for A/B variant assignment: a salted HMAC of
 * IP + User-Agent (the same two signals the anonymous stats fingerprint
 * uses, under a different construction so the two stores never correlate).
 *
 * Properties the A/B engine relies on:
 *   • STABLE — the same visitor (same network + browser) hashes to the same
 *     id on every request, so their variant arm never flips mid-experiment;
 *   • SERVER-MINTED — the client never supplies it, so a visitor cannot
 *     choose their arm (only the server sees the inputs and the secret);
 *   • ANONYMOUS — a one-way HMAC prefix, never the raw IP.
 */
export function visitorStableId(
  ip: string | null | undefined,
  userAgent: string | null | undefined,
): string {
  const ipValue = (ip ?? '').trim() || 'unknown'
  const uaValue = (userAgent ?? '').trim() || 'unknown'
  return crypto
    .createHmac('sha256', adsEventSecret)
    .update(`${ipValue}|${uaValue}`)
    .digest('hex')
    .slice(0, 32)
}
