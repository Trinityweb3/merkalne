import { jsonOk } from '@/lib/api'
import { getLatestDailyStats } from '@/lib/stats/aggregate'

/**
 * GET /api/stats/latest — the public daily snapshot rendered on /about.
 *
 * Returns { asOf: null, snapshot: null } until the first snapshot exists
 * (fresh deploy before the worker's first daily tick) — the UI renders an
 * honest "statistics start today" state from that, never zeros-as-fact.
 *
 * Raw numbers + ISO codes only (no localized strings) so a future i18n layer
 * translates labels without touching this contract.
 */
export async function GET() {
  const latest = await getLatestDailyStats()
  if (!latest) {
    return jsonOk(
      { asOf: null, snapshot: null },
      { headers: { 'Cache-Control': 'public, max-age=300' } },
    )
  }
  return jsonOk(
    { asOf: latest.date.toISOString(), snapshot: latest.data },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  )
}
