'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BarChart3, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, ApiError } from '@/lib/api-client'
import { reportCount, reportCtr, reportEcpc, reportSpent } from '@/lib/ads/report-format'

/**
 * AdsReportsView — the "Reports" tab of the advertiser dashboard (Phase 3).
 *
 * Real delivery metrics per campaign, straight from the event pipeline:
 * Impressions (loaded_impression), Viewable Impressions (viewable_
 * impression), Clicks (valid_click), CTR = clicks/impressions, Spent (the
 * ledger's Σ|charge|) and eCPC = spent/clicks.
 *
 * NO-DATA RULE: a metric without a meaningful value renders as an em dash
 * (—) — never a fake "$0.00" or "0%" (src/lib/ads/report-format.ts).
 *
 * "Download CSV" streams /api/ads/reports/export — a formula-safe CSV
 * (cells with a leading =, +, - or @ are single-quote-prefixed) that
 * always matches the numbers rendered here.
 */
interface ReportRow {
  campaignId: string
  name: string
  status: string
  format: string
  billingModel: 'cpc' | 'cpm'
  bidLabel: string
  impressions: number
  viewableImpressions: number
  clicks: number
  ctr: number | null
  spentMicroUsd: number
  ecpcMicroUsd: number | null
}

interface ReportsPayload {
  campaigns: ReportRow[]
  generatedAt: string
}

export function AdsReportsView() {
  const t = useTranslations('ads')
  const [rows, setRows] = useState<ReportRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api<ReportsPayload>('/api/ads/reports')
      .then((data) => {
        if (!cancelled) setRows(data?.campaigns ?? [])
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : t('errorGeneric'))
        setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  function statusBadge(status: string): { label: string; cls: string } {
    switch (status) {
      case 'active':
        return { label: t('statusActive'), cls: 'state-active' }
      case 'pending':
        return { label: t('statusPending'), cls: 'state-under-review' }
      case 'rejected':
        return { label: t('statusRejected'), cls: 'state-draft' }
      case 'draft':
        return { label: t('statusDraft'), cls: 'state-draft' }
      case 'paused':
        return { label: t('statusPaused'), cls: 'state-under-review' }
      default:
        return { label: t('statusCompleted'), cls: 'state-draft' }
    }
  }

  return (
    <div>
      <div className="section-block">
        <div className="section-title row between wrap" style={{ gap: 12 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BarChart3 width={18} height={18} aria-hidden />
            {t('reportsTitle')}
          </h2>
          {/* Plain navigation GET — the browser streams the file download. */}
          <Button asChild>
            <a href="/api/ads/reports/export" download>
              <Download width={15} height={15} aria-hidden />
              {t('downloadCsv')}
            </a>
          </Button>
        </div>
        <p className="muted small" style={{ marginTop: 4 }}>
          {t('reportsHint')}
        </p>

        {error ? (
          <p className="negative small" role="alert" style={{ marginTop: 10 }}>
            {error}
          </p>
        ) : null}

        {rows === null ? (
          <p className="muted small" style={{ marginTop: 12 }}>
            {t('reportsLoading')}
          </p>
        ) : rows.length === 0 ? (
          <div className="empty-state card" style={{ textAlign: 'center', marginTop: 12 }}>
            <h3>{t('reportsEmpty')}</h3>
          </div>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>{t('colCampaign')}</th>
                  <th>{t('colStatus')}</th>
                  <th>{t('colBilling')}</th>
                  <th className="text-end">{t('colImpressions')}</th>
                  <th className="text-end">{t('colViewable')}</th>
                  <th className="text-end">{t('colClicks')}</th>
                  <th className="text-end">{t('colCtr')}</th>
                  <th className="text-end">{t('colSpent')}</th>
                  <th className="text-end">{t('colEcpc')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const badge = statusBadge(r.status)
                  return (
                    <tr key={r.campaignId} className="data-row">
                      <td className="min-w-0">
                        <span className="block truncate">{r.name}</span>
                        <span className="muted small">{r.bidLabel}</span>
                      </td>
                      <td>
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="muted">{r.billingModel === 'cpc' ? 'CPC' : 'CPM'}</td>
                      <td className="text-end">{reportCount(r.impressions)}</td>
                      <td className="text-end">{reportCount(r.viewableImpressions)}</td>
                      <td className="text-end">{reportCount(r.clicks)}</td>
                      <td className="text-end">{reportCtr(r.ctr)}</td>
                      <td className="text-end">{reportSpent(r.spentMicroUsd)}</td>
                      <td className="text-end">{reportEcpc(r.ecpcMicroUsd)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="muted small" style={{ marginTop: 10 }}>
          {t('csvNote')}
        </p>
      </div>
    </div>
  )
}
