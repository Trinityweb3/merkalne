/**
 * Merklane Ads Phase 3 — report display formats (PURE module).
 *
 * Shared by the Reports tab (src/components/site/ads/ads-reports.tsx) and
 * the CSV export (src/app/api/ads/reports/export/route.ts) so both always
 * render the SAME numbers.
 *
 * THE NO-DATA RULE (Phase 3 spec, Task 4): when a metric has no meaningful
 * value it renders as an EM DASH (—) — never as a misleading "$0.00" or
 * "0%":
 *
 *   • Spent  → "—" while no charge has landed (spent = 0); the real amount
 *              from the first charge on.
 *   • CTR    → "—" while there are no impressions (division undefined).
 *   • eCPC   → "—" while there are no clicks (division undefined) or while
 *              nothing was spent.
 *
 * Counts (impressions / viewable impressions / clicks) are honest integers
 * — a 0 there IS the data.
 */
import { formatMicroUsd } from '@/lib/ads/money'

/** The no-data marker — an em dash, exactly as specified. */
export const NO_DATA = '—'

/** Spent: money from the ledger; "—" until the first charge lands. */
export function reportSpent(spentMicroUsd: number | null | undefined): string {
  if (spentMicroUsd === null || spentMicroUsd === undefined || spentMicroUsd <= 0) return NO_DATA
  return formatMicroUsd(spentMicroUsd)
}

/** CTR = clicks ÷ impressions; "—" while impressions are 0. */
export function reportCtr(ctr: number | null | undefined): string {
  if (ctr === null || ctr === undefined || !Number.isFinite(ctr)) return NO_DATA
  return `${(ctr * 100).toFixed(2)}%`
}

/** eCPC = spent ÷ clicks; "—" while clicks are 0 or nothing was spent. */
export function reportEcpc(ecpcMicroUsd: number | null | undefined): string {
  if (ecpcMicroUsd === null || ecpcMicroUsd === undefined || ecpcMicroUsd <= 0) return NO_DATA
  return formatMicroUsd(ecpcMicroUsd)
}

/** Integer counts render as-is (0 is real data, not "no data"). */
export function reportCount(n: number | null | undefined): string {
  const value = n ?? 0
  return Number.isFinite(value) ? String(Math.max(0, Math.round(value))) : NO_DATA
}
