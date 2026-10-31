import { handleRouteError, jsonError } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { expireStaleReservations } from '@/lib/ads/auction'
import { canViewReports } from '@/lib/ads/permissions'
import { campaignReportRows, type CampaignReportRow } from '@/lib/ads/reporting'
import { reportSpent, reportCtr, reportEcpc, reportCount } from '@/lib/ads/report-format'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads/reports/export — "Download CSV" for the Reports tab.
 *
 * One row per campaign: name, status, billing, bid, impressions, viewable
 * impressions, clicks, CTR, spent, eCPC. No-data metrics export as an em
 * dash (—), identical to what the tab renders — never a fake "$0.00" or
 * "0%".
 *
 * CSV INJECTION PROTECTION (Phase 3 spec, Task 4): every cell passes
 * sanitizeCsvCell() — a leading =, +, - or @ (also tab/CR, the quieter
 * Excel/Sheets formula triggers) gets a single-quote prefix, so a campaign
 * named "=SUM(A1:A2)" or "@cmd|…" exports as text and can never execute as
 * a formula when the file is opened in a spreadsheet. Values that contain
 * commas/quotes/newlines are additionally RFC 4180-quoted.
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    // Phase-4 permission gate — the CSV export IS a report (OWNER +
    // EDITOR + ANALYST, same as the Reports tab).
    if (!canViewReports(session.user)) {
      return jsonError('Your role does not allow viewing reports.', 403, {
        code: 'forbidden_role',
      })
    }

    await expireStaleReservations()
    const rows = await campaignReportRows(session.user.id)

    const header = [
      'Campaign',
      'Status',
      'Billing',
      'Bid (USD)',
      'Impressions',
      'Viewable impressions',
      'Clicks',
      'CTR',
      'Spent',
      'eCPC',
    ]
    const body = rows.map((r) => reportRowCells(r))
    const csv = [header, ...body].map((cells) => cells.join(',')).join('\r\n')

    const stamp = new Date().toISOString().slice(0, 10)
    return new Response(`\uFEFF${csv}\r\n`, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="merklane-ads-report-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return handleRouteError(err)
  }
}

// ---------------------------------------------------------------------------
// CSV cell safety
// ---------------------------------------------------------------------------

/** Leading characters that turn a cell into a formula in Excel / Sheets. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/

/**
 * Neutralise a spreadsheet formula trigger: prefix with a single quote.
 * Applied to EVERY cell, so even advertiser-controlled strings (campaign
 * names) can never execute when the exported file is opened.
 */
export function sanitizeCsvCell(raw: string): string {
  const value = raw ?? ''
  if (FORMULA_PREFIX.test(value)) return `'${value}`
  return value
}

/** Full RFC 4180 escaping applied AFTER the formula guard. */
function csvCell(raw: string): string {
  const guarded = sanitizeCsvCell(raw)
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`
  return guarded
}

function reportRowCells(r: CampaignReportRow): string[] {
  return [
    csvCell(r.name),
    csvCell(r.status),
    csvCell(r.billingModel === 'cpc' ? 'CPC' : 'CPM'),
    csvCell(r.bidLabel),
    csvCell(reportCount(r.impressions)),
    csvCell(reportCount(r.viewableImpressions)),
    csvCell(reportCount(r.clicks)),
    csvCell(reportCtr(r.ctr)),
    csvCell(reportSpent(r.spentMicroUsd)),
    csvCell(reportEcpc(r.ecpcMicroUsd)),
  ]
}
