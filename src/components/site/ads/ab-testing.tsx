'use client'

/**
 * A/B Testing — the Phase-4 tab of the campaign details.
 *
 * Opened from a campaign card ("A/B Testing" button). Everything is driven
 * by GET /api/ads/campaigns/[id]/experiments:
 *
 *   • CREATE — exactly two APPROVED creatives of the campaign become
 *     Variants A and B (the API refuses anything else); the primary metric
 *     is CTR. The test is born DRAFT — nothing changes in the auction until
 *     the advertiser starts it.
 *   • RUN — Start / Pause / Finish (PATCH /api/ads/experiments/[id]). While
 *     RUNNING the campaign keeps its SINGLE auction weight; after it wins
 *     an impression a stable hash of the visitor id picks the variant
 *     (50/50, sticky per visitor — the server does this, the client cannot
 *     influence it).
 *   • STATISTICS — impressions, clicks, CTR and eCPC per variant, straight
 *     from the server-side attribution (BudgetReservation.variantId joined
 *     with the AdEvent funnel). The verdict row shows the two-proportion
 *     z-test on CTR: a winner is declared ONLY with ≥ 100 impressions per
 *     variant AND p ≤ 0.05 — anything less renders the honest
 *     "Insufficient data" and never a premature winner.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FlaskConical, Loader2, Pause, Play, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api-client'
import { formatMicroUsd } from '@/lib/ads/money'

export interface AbCreativeOption {
  id: string
  version: number
  title: string | null
  body: string | null
  imageUrl: string | null
  altText: string | null
  displayDomain: string | null
  targetUrl: string
  createdAt: string
}

export interface AbVariantStats {
  variant: 'A' | 'B'
  creativeId: string
  impressions: number
  clicks: number
  ctr: number | null
  spentMicroUsd: number
  ecpcMicroUsd: number | null
}

export interface AbExperiment {
  experimentId: string
  campaignId: string
  status: 'draft' | 'running' | 'finished' | string
  primaryMetric: string
  startedAt: string | null
  endedAt: string | null
  variants: [AbVariantStats, AbVariantStats]
  assignedVisitors: { A: number; B: number }
  verdict:
    | { kind: 'insufficient'; reason: string }
    | { kind: 'winner'; variant: 'A' | 'B'; pValue: number; z: number }
    | { kind: 'no_difference'; pValue: number; z: number }
}

interface ExperimentsPayload {
  campaignId: string
  campaignStatus: string
  canCreateNew: boolean
  approvedCreatives: AbCreativeOption[]
  experiments: AbExperiment[]
}

/** Compact label for a creative option ("v3 — Hire Web3 engineers"). */
function creativeLabel(c: AbCreativeOption): string {
  const head = c.title?.trim() || c.altText?.trim() || c.targetUrl
  return `v${c.version} — ${head.length > 46 ? `${head.slice(0, 46)}…` : head}`
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(2)}%`
}

export function AbTestingPanel({
  campaignId,
  campaignName,
  onClose,
  onChanged,
}: {
  campaignId: string
  campaignName: string
  onClose: () => void
  /** Refresh the dashboard (the campaign card may show the running test). */
  onChanged: () => void
}) {
  const t = useTranslations('ads')
  const tc = useTranslations('common')

  const [data, setData] = useState<ExperimentsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Create-form state (pickers default to the two newest approved versions).
  const [pickA, setPickA] = useState('')
  const [pickB, setPickB] = useState('')

  const load = useCallback(async () => {
    try {
      const payload = await api<ExperimentsPayload>(`/api/ads/campaigns/${campaignId}/experiments`)
      setData(payload)
      setError(null)
      // Default picks: the two newest approved creatives (highest versions).
      setPickA((prev) => (prev && payload.approvedCreatives.some((c) => c.id === prev) ? prev : (payload.approvedCreatives[0]?.id ?? '')))
      setPickB((prev) =>
        prev && payload.approvedCreatives.some((c) => c.id === prev)
          ? prev
          : (payload.approvedCreatives[1]?.id ?? ''),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    }
  }, [campaignId, t])

  useEffect(() => {
    void load()
  }, [load])

  async function createExperiment() {
    if (!pickA || !pickB || pickA === pickB) return
    setBusy(true)
    setError(null)
    try {
      await api(`/api/ads/campaigns/${campaignId}/experiments`, {
        method: 'POST',
        body: { creativeAId: pickA, creativeBId: pickB, primaryMetric: 'ctr' },
      })
      await load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  async function control(experimentId: string, action: 'start' | 'pause' | 'finish') {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/ads/experiments/${experimentId}`, {
        method: 'PATCH',
        body: { action },
      })
      await load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  function statusBadge(status: string) {
    const cls =
      status === 'running'
        ? 'state-active'
        : status === 'finished'
          ? 'state-draft'
          : 'state-under-review'
    const label =
      status === 'running'
        ? t('abStatusRunning')
        : status === 'finished'
          ? t('abStatusFinished')
          : t('abStatusDraft')
    return <span className={`badge ${cls}`}>{label}</span>
  }

  function verdict(experiment: AbExperiment) {
    const v = experiment.verdict
    if (v.kind === 'winner') {
      const winner = experiment.variants.find((s) => s.variant === v.variant)
      return (
        <p className="positive small" role="status">
          🏆 {t('abWinner', { variant: v.variant })} — {t('colCtr')} {pct(winner?.ctr ?? null)} ·{' '}
          {t('abPValue', { value: v.pValue.toFixed(3) })}
        </p>
      )
    }
    if (v.kind === 'no_difference') {
      return (
        <p className="muted small" role="status">
          {t('abNoDifference')} · {t('abPValue', { value: v.pValue.toFixed(3) })}
        </p>
      )
    }
    return (
      <p className="muted small" role="status">
        ⏳ <strong>{t('abInsufficient')}</strong> — {t('abInsufficientHint')}
      </p>
    )
  }

  const creatives = data?.approvedCreatives ?? []

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-black/60 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('abTitle')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="card w-full max-w-[720px] shadow-2xl" style={{ maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="row between">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FlaskConical width={18} height={18} aria-hidden />
            {t('abTitle')} — {campaignName}
          </h3>
          <button type="button" className="icon-button" aria-label={tc('cancel')} onClick={onClose}>
            <X width={16} height={16} aria-hidden />
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 6, lineHeight: 1.7 }}>
          {t('abIntro')}
        </p>

        {error ? (
          <p className="negative small" role="alert" style={{ marginTop: 10 }}>
            {error}
          </p>
        ) : null}

        {!data ? (
          <p className="muted small" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Loader2 width={14} height={14} className="animate-spin" aria-hidden />
            {tc('loading')}
          </p>
        ) : (
          <>
            {/* ------------------------------------------------ create form */}
            {data.canCreateNew && creatives.length >= 2 ? (
              <div className="field" style={{ marginTop: 16, padding: 14, border: '1px dashed var(--chart-4, #8b9dc3)', borderRadius: 10 }}>
                <label className="field-label">{t('abCreateTitle')}</label>
                {([
                  ['A', pickA, setPickA] as const,
                  ['B', pickB, setPickB] as const,
                ]).map(([arm, picked, setPicked]) => (
                  <div className="field" key={arm} style={{ marginTop: 10 }}>
                    <label className="field-label">{arm === 'A' ? t('abVariantA') : t('abVariantB')}</label>
                    <div className="row wrap" style={{ gap: 8 }}>
                      {creatives.map((c) => (
                        <button
                          type="button"
                          key={c.id}
                          className={`chip ${picked === c.id ? 'selected' : ''}`}
                          aria-pressed={picked === c.id}
                          onClick={() => setPicked(c.id)}
                        >
                          {creativeLabel(c)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="muted tiny" style={{ marginTop: 8 }}>
                  {t('abMetricLabel')}: <strong>{t('abMetricCtr')}</strong> · {t('abSplitNote')}
                </p>
                <div className="button-row" style={{ marginTop: 10 }}>
                  <Button
                    type="button"
                    onClick={createExperiment}
                    disabled={busy || !pickA || !pickB || pickA === pickB}
                  >
                    {busy ? tc('loading') : t('abCreateBtn')}
                  </Button>
                </div>
              </div>
            ) : data.experiments.length === 0 ? (
              <div className="empty-state card" style={{ textAlign: 'center', marginTop: 16 }}>
                <h3>{t('abEmpty')}</h3>
                <p className="muted small" style={{ marginTop: 8 }}>
                  {t('abNeedTwo')}
                </p>
              </div>
            ) : null}

            {/* ------------------------------------------------ experiments */}
            {data.experiments.map((experiment) => {
              const live = experiment.status === 'draft' || experiment.status === 'running'
              return (
                <div key={experiment.experimentId} className="section-block" style={{ marginTop: 18 }}>
                  <div className="row between wrap" style={{ gap: 10 }}>
                    <div className="row" style={{ gap: 10 }}>
                      <strong>{t('abTestLabel')}</strong>
                      {statusBadge(experiment.status)}
                    </div>
                    <div className="row wrap" style={{ gap: 8 }}>
                      {live && experiment.status === 'draft' ? (
                        <Button
                          variant="outline"
                          type="button"
                          disabled={busy}
                          onClick={() => control(experiment.experimentId, 'start')}
                        >
                          <Play width={14} height={14} aria-hidden />
                          {t('abStart')}
                        </Button>
                      ) : null}
                      {experiment.status === 'running' ? (
                        <Button
                          variant="outline"
                          type="button"
                          disabled={busy}
                          onClick={() => control(experiment.experimentId, 'pause')}
                        >
                          <Pause width={14} height={14} aria-hidden />
                          {t('abPause')}
                        </Button>
                      ) : null}
                      {live ? (
                        <Button
                          variant="outline"
                          type="button"
                          disabled={busy}
                          onClick={() => control(experiment.experimentId, 'finish')}
                        >
                          <Square width={14} height={14} aria-hidden />
                          {t('abFinish')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <p className="tiny muted" style={{ marginTop: 4 }}>
                    {experiment.startedAt
                      ? `${t('abStartedAt')} ${new Date(experiment.startedAt).toLocaleString()}${
                          experiment.endedAt ? ` · ${t('abEndedAt')} ${new Date(experiment.endedAt).toLocaleString()}` : ''
                        }`
                      : t('abNotStarted')}
                  </p>

                  <div className="table-wrap" style={{ marginTop: 10 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>{t('abColVariant')}</th>
                          <th>{t('colImpressions')}</th>
                          <th>{t('colClicks')}</th>
                          <th>{t('colCtr')}</th>
                          <th>{t('colEcpc')}</th>
                          <th>{t('abColVisitors')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {experiment.variants.map((v) => (
                          <tr key={v.variant} className="data-row">
                            <td>
                              <strong>{t('abVariantLabel', { variant: v.variant })}</strong>
                            </td>
                            <td>{v.impressions}</td>
                            <td>{v.clicks}</td>
                            <td>{pct(v.ctr)}</td>
                            <td>{v.ecpcMicroUsd === null ? '—' : formatMicroUsd(v.ecpcMicroUsd)}</td>
                            <td className="muted">{experiment.assignedVisitors[v.variant]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ marginTop: 10 }}>{verdict(experiment)}</div>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
