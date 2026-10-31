import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { expireStaleReservations } from '@/lib/ads/auction'
import { canViewReports } from '@/lib/ads/permissions'
import { campaignReportRows } from '@/lib/ads/reporting'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads/reports — the Phase 3 Reports tab data.
 *
 * Real delivery metrics per campaign, aggregated from AdEvent (the funnel)
 * and the ledger (the money):
 *   Impressions (loaded_impression) · Viewable Impressions
 *   (viewable_impression) · Clicks (valid_click) · CTR = clicks/impressions ·
 *   Spent (Σ|charge|) · eCPC = spent/clicks.
 *
 * Metrics that have no meaningful value yet are NULL (never 0 / "0%") —
 * the UI renders them as an em dash (see src/lib/ads/report-format.ts).
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    // Phase-4 permission gate: reports are OWNER + EDITOR + ANALYST (an
    // analyst is the read-only delivery-statistics tier).
    if (!canViewReports(session.user)) {
      return jsonError('Your role does not allow viewing reports.', 403, {
        code: 'forbidden_role',
      })
    }

    // Sweep first so holds that never saw a validating event stop counting
    // against the budgets (the same read-time hygiene as the campaigns API).
    await expireStaleReservations()

    const campaigns = await campaignReportRows(session.user.id)
    return jsonOk({ campaigns, generatedAt: new Date().toISOString() })
  } catch (err) {
    return handleRouteError(err)
  }
}
