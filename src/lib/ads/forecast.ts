/**
 * Merklane Ads Phase 4 — delivery forecasting (the "what to expect before
 * you spend" helper of wizard Step 4).
 *
 * INPUT: the campaign's planned targeting (sections, locales — the two
 * dimensions the wizard's Step 3 selections pin down before money moves).
 *
 * BASIS: the last 7 UTC days of REAL platform delivery — loaded_impression
 * AdEvent rows, written server-side at serve time (they cannot be forged
 * or missed by the client, Phase 3). Since Phase 4 every such row also
 * stores the serving page's section + locale, so the estimate can be
 * FILTERED to the inventory the campaign could actually buy:
 *
 *   • an event matches the section filter when the campaign targets ALL
 *     sections, or the event's section is in the target list — events with
 *     NO section context (legacy rows / unsectioned pages) match every
 *     campaign, mirroring targetingMatches, which lets a page without a
 *     section parameter through;
 *   • the locale filter follows the same rule.
 *
 * OUTPUT:
 *   • daily impressions — the mean of the seven per-UTC-day matching
 *     counts, shown as a band mean ± 0.6σ (floored at 0): the
 *     "Est. 500 – 800 impressions/day" line;
 *   • daily clicks — the impressions band times the PLATFORM-WIDE CTR
 *     observed over the same window (clicks carry no page context — the
 *     signed ad token has none — so the honest click prior is how the whole
 *     site engages, applied to the targeted inventory);
 *   • missing days count as ZERO-delivery days: an average that skips them
 *     would overpromise.
 *
 * HONESTY RULE (the spec): with fewer than FORECAST_MIN_PLATFORM_IMPRESSIONS
 * loaded impressions on the WHOLE platform in the window, the answer is
 * "insufficient" — the UI shows "Insufficient data to forecast" instead of
 * inventing a number. A platform WITH enough data but no matching inventory
 * for a narrow targeting returns a sufficient forecast of ~0/day: that is
 * real information, not missing data.
 */
import { db } from '@/lib/db'

/** The lookback window, in UTC days. */
export const FORECAST_WINDOW_DAYS = 7

/** Platform-wide loaded impressions needed before any forecast is issued. */
export const FORECAST_MIN_PLATFORM_IMPRESSIONS = 1000

/** The band half-width in standard deviations of the daily counts. */
const BAND_SIGMA = 0.6

export interface ForecastRequest {
  /** Target section slugs; empty = every section. */
  sections?: string[]
  /** Target locale codes; empty = every language. */
  locales?: string[]
}

export interface ForecastRange {
  low: number
  high: number
}

export interface ForecastResult {
  /** false → the caller must show "Insufficient data to forecast". */
  sufficient: boolean
  /** Loaded impressions on the whole platform inside the window. */
  platformImpressions: number
  /** Impressions matching the requested targeting inside the window. */
  matchingImpressions: number
  /** Estimated daily impressions (the range the UI renders). */
  dailyImpressions: ForecastRange | null
  /** Estimated daily clicks (impressions band × platform CTR); null without a CTR prior. */
  dailyClicks: ForecastRange | null
  /** Platform-wide CTR over the window (clicks / impressions); null when no impressions. */
  ctr: number | null
  /** The UTC days the estimate is based on. */
  windowDays: number
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Per-UTC-day counts of the matching loaded_impressions inside the window.
 *
 * Implemented as one indexed Prisma COUNT per day (not a raw GROUP BY date
 * expression): the engines store DateTime differently (PostgreSQL keeps a
 * timestamp, the SQLite preview stores integer epoch-ms), so a portable
 * date-part expression does not exist. The matching rule mirrors
 * targetingMatches — an event with NO stored context matches every campaign;
 * with a context it must be in the target list.
 */
async function dailyImpressionCounts(
  from: Date,
  until: Date,
  sections: string[],
  locales: string[],
): Promise<number[]> {
  const contextFilter = [
    ...(sections.length > 0 ? [{ OR: [{ section: { in: sections } }, { section: null }] }] : []),
    ...(locales.length > 0 ? [{ OR: [{ locale: { in: locales } }, { locale: null }] }] : []),
  ]
  const counts: number[] = []
  for (let d = 0; d < FORECAST_WINDOW_DAYS; d++) {
    const dayStart = new Date(from.getTime() + d * 86_400_000)
    const dayEnd = new Date(from.getTime() + (d + 1) * 86_400_000)
    counts.push(
      await db.adEvent.count({
        where: {
          eventType: 'loaded_impression',
          createdAt: {
            gte: dayStart,
            // The last bucket is capped at "now" (partial day — an honest
            // average must not extrapolate the day before it is over).
            lt: d === FORECAST_WINDOW_DAYS - 1 ? (until < dayEnd ? until : dayEnd) : dayEnd,
          },
          ...(contextFilter.length > 0 ? { AND: contextFilter } : {}),
        },
      }),
    )
  }
  return counts
}

/**
 * The forecast for one targeting configuration. `now` is injectable for
 * tests; defaults to the current instant.
 */
export async function forecastDelivery(
  req: ForecastRequest = {},
  now: Date = new Date(),
): Promise<ForecastResult> {
  const sections = [...new Set((req.sections ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))]
  const locales = [...new Set((req.locales ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))]

  const startOfToday = startOfUtcDay(now)
  const from = new Date(startOfToday.getTime() - (FORECAST_WINDOW_DAYS - 1) * 86_400_000)

  // ---- the sufficiency gate: whole-platform volume in the window --------
  const platformImpressions = await db.adEvent.count({
    where: { eventType: 'loaded_impression', createdAt: { gte: from, lte: now } },
  })
  if (platformImpressions < FORECAST_MIN_PLATFORM_IMPRESSIONS) {
    return {
      sufficient: false,
      platformImpressions,
      matchingImpressions: 0,
      dailyImpressions: null,
      dailyClicks: null,
      ctr: null,
      windowDays: FORECAST_WINDOW_DAYS,
    }
  }

  // ---- the filtered window ----------------------------------------------
  const daily = await dailyImpressionCounts(from, now, sections, locales)

  const totalImpressions = daily.reduce((sum, n) => sum + n, 0)
  const mean = totalImpressions / FORECAST_WINDOW_DAYS
  const variance =
    daily.reduce((sum, n) => sum + (n - mean) * (n - mean), 0) / FORECAST_WINDOW_DAYS
  const sigma = Math.sqrt(variance)

  const low = Math.max(0, Math.round(mean - BAND_SIGMA * sigma))
  const high = Math.max(low, Math.round(mean + BAND_SIGMA * sigma))

  // ---- the click prior: platform-wide CTR over the same window ----------
  const [platformClicks] = await Promise.all([
    db.adEvent.count({
      where: { eventType: 'valid_click', createdAt: { gte: from, lte: now } },
    }),
  ])
  const ctr = platformImpressions > 0 ? platformClicks / platformImpressions : null
  const dailyClicks =
    ctr !== null
      ? { low: Math.max(0, Math.round(low * ctr)), high: Math.max(0, Math.round(high * ctr)) }
      : null

  return {
    sufficient: true,
    platformImpressions,
    matchingImpressions: totalImpressions,
    dailyImpressions: { low, high },
    dailyClicks,
    ctr,
    windowDays: FORECAST_WINDOW_DAYS,
  }
}
