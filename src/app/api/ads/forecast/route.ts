import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import {
  FORECAST_MIN_PLATFORM_IMPRESSIONS,
  FORECAST_WINDOW_DAYS,
  forecastDelivery,
} from '@/lib/ads/forecast'
import { AD_SECTION_CONTEXTS, AD_LOCALE_CODES } from '@/lib/ads/targeting'

export const dynamic = 'force-dynamic'

/** Input caps — the same sizes the campaign API accepts for targeting. */
const MAX_SECTIONS = 6
const MAX_LOCALES = 20

/** Split a comma-separated query param into clean lowercase values. */
function splitParam(raw: string, max: number): string[] {
  const out: string[] = []
  for (const part of raw.split(',')) {
    const value = part.trim().toLowerCase().slice(0, 40)
    if (!value) continue
    if (!out.includes(value)) out.push(value)
    if (out.length >= max) break
  }
  return out
}

/**
 * GET /api/ads/forecast?sections=intern-junior,markets&locales=en — the
 * Phase-4 delivery estimate for wizard Step 4 (Bidding & Budget).
 *
 * The advertiser's planned targeting from Step 3 is echoed as query params;
 * the answer is the estimated DAILY impressions/clicks range derived from
 * the last 7 days of real loaded_impression delivery, filtered by the same
 * page-context dimensions the auction filters by (section, locale).
 *
 *   sections  optional comma-separated target section slugs (only known
 *             slugs are honoured — a crafted list can neither widen nor
 *             narrow other advertisers' numbers)
 *   locales   optional comma-separated interface locale codes (same rule)
 *
 * Fallback (the spec): fewer than 1000 platform-wide loaded impressions in
 * the window → { sufficient: false } and the UI shows
 * "Insufficient data to forecast" — never an invented number.
 *
 * Session required (an advertiser tool), read-only (no CSRF), rate-limited.
 */
export async function GET(req: Request) {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const rl = rateLimit(`ads-forecast:${clientIp(req)}`, 30, 60_000)
    if (!rl.ok) return jsonError('Too many requests — try again in a minute.', 429)

    const params = new URL(req.url).searchParams

    // Only KNOWN sections/locales are honoured — mirrors the serve route,
    // so a crafted query cannot probe arbitrary dimensions.
    const sections = splitParam(params.get('sections') ?? '', MAX_SECTIONS).filter((s) =>
      (AD_SECTION_CONTEXTS as readonly string[]).includes(s),
    )
    const locales = splitParam(params.get('locales') ?? '', MAX_LOCALES).filter((l) =>
      (AD_LOCALE_CODES as readonly string[]).includes(l),
    )

    const forecast = await forecastDelivery({ sections, locales })
    return jsonOk({
      ...forecast,
      windowDays: FORECAST_WINDOW_DAYS,
      minPlatformImpressions: FORECAST_MIN_PLATFORM_IMPRESSIONS,
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
