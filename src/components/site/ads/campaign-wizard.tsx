'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ImagePlus,
  Loader2,
  Save,
  Send,
  Target,
  TrendingUp,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api-client'
import { LANGUAGES, POST_SECTIONS, SECTION_META } from '@/lib/constants'
import {
  BID_BOUNDS,
  DAILY_BUDGET_BOUNDS,
  type AdFormat,
  type BillingModel,
  budgetEventEstimate,
  centsToMicro,
  formatMicroUsd,
  minTotalBudgetCents,
} from '@/lib/ads/money'

/**
 * CampaignWizard — the Phase 2 five-step campaign builder.
 *
 *   Step 1  Name & Format (text / banner)
 *   Step 2  Creative — text: title/body/display domain/target URL;
 *           banner: UPLOAD (real file, magic-byte-validated server-side),
 *           alt text, target URL
 *   Step 3  Targeting — keywords (+ exact/phrase), sections, languages,
 *           countries (ALL/INCLUDE/EXCLUDE, ISO codes), hashtags
 *   Step 4  Bidding & Budget — CPC/CPM (independent of format), bid in the
 *           model's unit, initial budget, daily cap
 *   Step 5  Summary & Submit — review everything, then submit for review
 *
 * "Save as draft" works from EVERY step (drafts are free — no wallet money
 * is locked until submission). Submission pushes the campaign to PENDING:
 * it only ever goes ACTIVE after a moderator approves it (Telegram admin
 * bot → 🛡 Moderation Queue).
 *
 * Editing an APPROVED campaign creates a new creative revision and sends
 * the campaign back to review (shown as a hint before saving).
 *
 * Styling stays in the legacy template vocabulary (card, chip, badge,
 * field, form-grid, span-2) plus Tailwind utilities for the progress bar,
 * exactly like the rest of the ads dashboard.
 */

export interface WizardCampaign {
  id: string
  name: string
  format: AdFormat
  billingModel: BillingModel
  bidMicroUsd: number
  dailyBudgetMicroUsd: number
  totalBudgetMicroUsd: number
  status: string
  targetSections: string[]
  targetLocales: string[]
  targetKeywords: string[]
  keywordMatch: 'phrase' | 'exact' | string
  countryMode: 'all' | 'include' | 'exclude' | string
  targetCountries: string[]
  targetHashtags: string[]
  creative: {
    title: string | null
    body: string | null
    imageUrl: string | null
    altText: string | null
    displayDomain: string | null
    targetUrl: string
    version: number
    moderationStatus: string
    moderationNote: string | null
  } | null
}

const CPC_BID_CHOICES = [10, 25, 50, 100] // US cents per click
const CPM_BID_CHOICES = [50, 100, 200, 500] // US cents per 1000 views
const BUDGET_CHOICES = [100, 500, 1000, 2500] // US cents total budget
const DAILY_CHOICES = [0, 100, 500, 1000] // US cents per day (0 = no cap)

const TOTAL_STEPS = 5
const MAX_UPLOAD_BYTES = 1_572_864 // 1.5 MB — mirrored by the upload API

/** "0.50" → 50 (cents). Returns NaN for garbage. */
function dollarsToCents(input: string): number {
  const value = Number.parseFloat(input)
  if (!Number.isFinite(value) || value < 0) return Number.NaN
  return Math.round(value * 100)
}

function centsMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** ISO region code → English country name ("DE" → "Germany"). */
function countryName(code: string): string {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' })
    return dn.of(code) ?? code
  } catch {
    return code
  }
}

/** The picker's suggestion pool: every ISO code the runtime knows. */
function allCountryCodes(): string[] {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' })
    const out: string[] = []
    for (let i = 0x41; i <= 0x5a; i++) {
      for (let j = 0x41; j <= 0x5a; j++) {
        const code = String.fromCharCode(i) + String.fromCharCode(j)
        const name = dn.of(code)
        if (name && name !== code) out.push(code)
      }
    }
    return out
  } catch {
    return []
  }
}

/** Browser fetch for multipart uploads — mirrors api()'s CSRF behaviour. */
async function apiUpload(path: string, file: File): Promise<{ url: string }> {
  const csrf = document.cookie.match(/(?:^|;\s*)merklane_csrf=([^;]+)/)?.[1]
  const body = new FormData()
  body.append('file', file)
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}),
    },
    credentials: 'same-origin',
    body,
  })
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: { url?: string }; error?: string }
    | null
  if (!res.ok || !payload?.ok || !payload.data?.url) {
    throw new Error(payload?.error ?? 'Upload failed')
  }
  return { url: payload.data.url }
}

async function apiJson<T = unknown>(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<T> {
  const csrf = document.cookie.match(/(?:^|;\s*)merklane_csrf=([^;]+)/)?.[1]
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}),
    },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: T; error?: string }
    | null
  if (!res.ok || !payload?.ok) {
    throw new Error(payload?.error ?? 'Request failed')
  }
  return payload.data as T
}

const SECTION_OPTIONS = POST_SECTIONS.map((s) => ({ value: s, label: SECTION_META[s].title }))
const LOCALE_OPTIONS = LANGUAGES.map((l) => ({ value: l.code, label: l.native }))

export function CampaignWizard({
  mode,
  campaign,
  availableMicro,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  campaign?: WizardCampaign
  availableMicro: number
  onClose: () => void
  onSaved: () => Promise<void> | void
}) {
  const t = useTranslations('ads')
  const tc = useTranslations('common')

  // ------------------------------------------------------------------ state
  const [step, setStep] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'draft' | 'submit'>(null)

  // Step 1 — name & format
  const [name, setName] = useState(campaign?.name ?? '')
  const [format, setFormat] = useState<AdFormat>(campaign?.format ?? 'text')

  // Step 2 — creative
  const [title, setTitle] = useState(campaign?.creative?.title ?? '')
  const [bodyText, setBodyText] = useState(campaign?.creative?.body ?? '')
  const [imageUrl, setImageUrl] = useState(campaign?.creative?.imageUrl ?? '')
  const [altText, setAltText] = useState(campaign?.creative?.altText ?? '')
  const [displayDomain, setDisplayDomain] = useState(campaign?.creative?.displayDomain ?? '')
  const [targetUrl, setTargetUrl] = useState(campaign?.creative?.targetUrl ?? '')
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Step 3 — targeting
  const [sections, setSections] = useState<string[]>(campaign?.targetSections ?? [])
  const [locales, setLocales] = useState<string[]>(campaign?.targetLocales ?? [])
  const [keywordsRaw, setKeywordsRaw] = useState((campaign?.targetKeywords ?? []).join(', '))
  const [keywordMatch, setKeywordMatch] = useState<'phrase' | 'exact'>(
    campaign?.keywordMatch === 'exact' ? 'exact' : 'phrase',
  )
  const [countryMode, setCountryMode] = useState<'all' | 'include' | 'exclude'>(
    campaign?.countryMode === 'include' || campaign?.countryMode === 'exclude'
      ? campaign.countryMode
      : 'all',
  )
  const [countries, setCountries] = useState<string[]>(campaign?.targetCountries ?? [])
  const [countryQuery, setCountryQuery] = useState('')
  const [hashtagsRaw, setHashtagsRaw] = useState((campaign?.targetHashtags ?? []).join(', '))

  // Step 4 — bidding & budget
  const [billing, setBilling] = useState<BillingModel>(campaign?.billingModel ?? 'cpc')
  const [bid, setBid] = useState(
    campaign ? (campaign.bidMicroUsd / 1_000_000).toFixed(2) : '0.50',
  )
  const [budget, setBudget] = useState(
    campaign ? (campaign.totalBudgetMicroUsd / 1_000_000).toFixed(2) : '5',
  )
  const [daily, setDaily] = useState(
    campaign && campaign.dailyBudgetMicroUsd > 0
      ? (campaign.dailyBudgetMicroUsd / 1_000_000).toFixed(2)
      : '0',
  )

  // Phase 4 — the delivery forecast of Step 4 (Bidding & Budget): what the
  // campaign can expect per day, estimated from the last 7 days of REAL
  // loaded_impression delivery filtered by the Step-3 targeting selections
  // (sections + locales). Refetched (debounced) whenever those selections
  // change while Step 4 is open.
  const [forecast, setForecast] = useState<
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | {
        state: 'ready'
        sufficient: boolean
        platformImpressions: number
        dailyImpressions: { low: number; high: number } | null
        dailyClicks: { low: number; high: number } | null
      }
  >({ state: 'loading' })

  useEffect(() => {
    if (step !== 4) return
    setForecast({ state: 'loading' })
    const timer = setTimeout(async () => {
      const params = new URLSearchParams()
      if (sections.length > 0) params.set('sections', sections.join(','))
      if (locales.length > 0) params.set('locales', locales.join(','))
      try {
        const data = await api<{
          sufficient: boolean
          platformImpressions: number
          dailyImpressions: { low: number; high: number } | null
          dailyClicks: { low: number; high: number } | null
        }>(`/api/ads/forecast${params.size > 0 ? `?${params.toString()}` : ''}`)
        setForecast({ state: 'ready', ...data })
      } catch (err) {
        setForecast({
          state: 'error',
          message: err instanceof Error ? err.message : t('errorGeneric'),
        })
      }
    }, 400)
    return () => clearTimeout(timer)
    // sections/locales are the Step-3 selections the forecast filters by.
  }, [step, sections, locales, t])

  // Derived flags
  const editingFunded = mode === 'edit' && campaign?.status !== 'draft' // budget is locked
  const wasApproved =
    mode === 'edit' && (campaign?.status === 'active' || campaign?.status === 'paused')
  const canSubmit = mode === 'create' || campaign?.status === 'draft' || campaign?.status === 'rejected'

  const keywords = useMemo(
    () =>
      keywordsRaw
        .split(',')
        .map((k) => k.trim().toLowerCase().replace(/\s+/g, ' '))
        .filter(Boolean)
        .slice(0, 10),
    [keywordsRaw],
  )
  const hashtags = useMemo(
    () =>
      hashtagsRaw
        .split(',')
        .map((h) => h.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-'))
        .filter(Boolean)
        .slice(0, 10),
    [hashtagsRaw],
  )
  const countryPool = useMemo(allCountryCodes, [])
  const countrySuggestions = useMemo(() => {
    const q = countryQuery.trim().toLowerCase()
    if (!q) return []
    return countryPool
      .filter((code) => {
        const nm = countryName(code).toLowerCase()
        return code.toLowerCase().startsWith(q) || nm.startsWith(q) || nm.includes(` ${q}`)
      })
      .slice(0, 8)
  }, [countryQuery, countryPool])

  const bidCents = dollarsToCents(bid)
  const budgetCents = dollarsToCents(budget)
  const dailyCents = dollarsToCents(daily || '0')

  // ------------------------------------------------------------- validation
  function validateStep(n: number): string | null {
    if (n === 1) {
      if (name.trim().length < 3 || name.trim().length > 80) return t('errorNameLen')
      return null
    }
    if (n === 2) {
      if (!/^https:\/\//.test(targetUrl.trim())) return t('errorHttps')
      if (format === 'text') {
        if (title.trim().length < 3 || title.trim().length > 120) return t('errorTitleLen')
        if (bodyText.trim().length < 3 || bodyText.trim().length > 500) return t('errorBodyLen')
      } else {
        if (!imageUrl) return t('uploadNeeded')
        if (altText.trim().length < 2 || altText.trim().length > 120) return t('errorAltLen')
      }
      if (displayDomain.trim() && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(displayDomain.trim())) {
        return t('errorDisplayDomain')
      }
      return null
    }
    if (n === 3) {
      if (countryMode !== 'all' && countries.length === 0) return t('errorCountries')
      return null
    }
    if (n === 4) {
      const bounds = BID_BOUNDS[billing]
      if (Number.isNaN(bidCents) || bidCents < bounds.minCents || bidCents > bounds.maxCents) {
        return billing === 'cpc' ? t('bidCpcBounds') : t('bidCpmBounds')
      }
      if (!editingFunded) {
        const min = minTotalBudgetCents(billing, bidCents)
        if (Number.isNaN(budgetCents) || budgetCents < min) {
          return t('budgetMinHint', { min: formatMicroUsd(centsToMicro(min)) })
        }
        if (mode === 'create' && centsToMicro(budgetCents) > availableMicro) {
          return t('insufficientWallet')
        }
      }
      if (dailyCents !== 0 && dailyCents < DAILY_BUDGET_BOUNDS.minCents) return t('dailyBudgetHint')
      if (dailyCents !== 0 && dailyCents > (editingFunded ? Number.MAX_SAFE_INTEGER : budgetCents)) {
        return t('dailyBudgetHint')
      }
      return null
    }
    return null
  }

  function goNext() {
    const problem = validateStep(step)
    if (problem) return setError(problem)
    setError(null)
    setStep((s) => Math.min(TOTAL_STEPS, s + 1))
  }

  function goBack() {
    setError(null)
    setStep((s) => Math.max(1, s - 1))
  }

  // ---------------------------------------------------------------- payload
  function sharedPayload() {
    return {
      name: name.trim(),
      targetUrl: targetUrl.trim(),
      ...(displayDomain.trim() ? { displayDomain: displayDomain.trim() } : { displayDomain: '' }),
      ...(format === 'text'
        ? { headline: title.trim(), body: bodyText.trim() }
        : { imageUrl, altText: altText.trim() }),
      targetSections: sections,
      targetLocales: locales,
      targetKeywords: keywords,
      keywordMatch,
      countryMode,
      targetCountries: countries,
      targetHashtags: hashtags,
    }
  }

  // ------------------------------------------------------------------ saves
  async function saveDraft() {
    const problem = validateStep(1) // a draft only needs a name
    if (problem) return setError(problem)
    setBusy('draft')
    setError(null)
    try {
      if (mode === 'create') {
        await apiJson('/api/ads/campaigns', 'POST', {
          ...sharedPayload(),
          format,
          billingModel: billing,
          bidCents: Number.isNaN(bidCents) ? 50 : bidCents,
          budgetCents: Number.isNaN(budgetCents) ? 500 : budgetCents,
          dailyBudgetCents: Number.isNaN(dailyCents) ? 0 : dailyCents,
          submit: false,
        })
      } else {
        await apiJson(`/api/ads/campaigns/${campaign!.id}`, 'PATCH', {
          action: 'update',
          ...sharedPayload(),
          bidCents: Number.isNaN(bidCents) ? undefined : bidCents,
          dailyBudgetCents: Number.isNaN(dailyCents) ? 0 : dailyCents,
          // Drafts may still change the planned budget; funded campaigns
          // change their budget through "Add funds".
          ...(campaign!.status === 'draft' && !Number.isNaN(budgetCents)
            ? { budgetCents }
            : {}),
        })
      }
      onClose()
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
      setBusy(null)
    }
  }

  async function submitForReview() {
    // Validate EVERY step before submission.
    for (let n = 1; n <= 4; n++) {
      const problem = validateStep(n)
      if (problem) {
        setStep(n)
        return setError(problem)
      }
    }
    setBusy('submit')
    setError(null)
    try {
      if (mode === 'create') {
        await apiJson('/api/ads/campaigns', 'POST', {
          ...sharedPayload(),
          format,
          billingModel: billing,
          bidCents,
          budgetCents,
          dailyBudgetCents: dailyCents,
          submit: true,
        })
      } else {
        await apiJson(`/api/ads/campaigns/${campaign!.id}`, 'PATCH', {
          action: 'update',
          ...sharedPayload(),
          bidCents,
          dailyBudgetCents: dailyCents,
          ...(campaign!.status === 'draft' ? { budgetCents } : {}),
          submitForReview: true,
        })
      }
      onClose()
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
      setBusy(null)
    }
  }

  // ---------------------------------------------------------------- upload
  async function handleFile(file: File) {
    setError(null)
    if (file.size > MAX_UPLOAD_BYTES) {
      return setError(t('uploadErrorSize'))
    }
    setUploading(true)
    try {
      const { url } = await apiUpload('/api/ads/assets/upload', file)
      setImageUrl(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('uploadErrorType'))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ----------------------------------------------------------------- render
  const stepLabels = [t('step1Name'), t('step2Creative'), t('step3Targeting'), t('step4Bidding'), t('step5Summary')]
  const pct = (step / TOTAL_STEPS) * 100

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'create' ? t('createTitle') : t('editTitle')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="card w-full max-w-[640px] shadow-2xl"
        style={{ maxHeight: '92svh', overflowY: 'auto' }}
      >
        <div className="row between">
          <h3>{mode === 'create' ? t('createTitle') : t('editTitle')}</h3>
          <button type="button" className="icon-button" aria-label={tc('cancel')} onClick={onClose}>
            <X width={16} height={16} aria-hidden />
          </button>
        </div>

        {/* Progress bar — "Step N of 5" + fill + step chips */}
        <div style={{ marginTop: 14 }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="tiny muted" aria-live="polite">
              {t('wizardStepOf', { current: step, total: TOTAL_STEPS })} · {stepLabels[step - 1]}
            </span>
            <span className="tiny muted">{stepLabels[step - 1]}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={1} aria-valuemax={TOTAL_STEPS} aria-valuenow={step}>
            <div className="h-full rounded-full bg-chart-4 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
            {stepLabels.map((label, i) => {
              const n = i + 1
              const clickable = n < step
              return (
                <button
                  key={label}
                  type="button"
                  className={`chip ${n === step ? 'selected' : ''}`}
                  aria-current={n === step ? 'step' : undefined}
                  disabled={!clickable}
                  onClick={clickable ? () => setStep(n) : undefined}
                  style={clickable ? { cursor: 'pointer' } : { opacity: n < step ? 0.85 : 0.55 }}
                >
                  {n < step ? <CheckCircle2 width={12} height={12} aria-hidden /> : null} {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Rejection context for a rejected campaign being re-opened */}
        {campaign?.creative?.moderationNote ? (
          <p className="negative small" role="alert" style={{ marginTop: 12 }}>
            {t('wizardRejectedNote', { reason: campaign.creative.moderationNote })}
          </p>
        ) : null}

        <div style={{ marginTop: 16 }}>
          {/* ---------------------------------------------------- Step 1 */}
          {step === 1 ? (
            <div className="form-grid">
              <div className="field span-2">
                <label className="field-label" htmlFor="wz-name">
                  {t('fieldCampaignName')}
                </label>
                <Input
                  id="wz-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('fieldCampaignNamePh')}
                  maxLength={80}
                  required
                />
              </div>
              <div className="field span-2">
                <label className="field-label">{t('formatLabel')}</label>
                <div className="row wrap" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className={`chip ${format === 'text' ? 'selected' : ''}`}
                    aria-pressed={format === 'text'}
                    onClick={() => setFormat('text')}
                  >
                    {t('formatText')}
                  </button>
                  <button
                    type="button"
                    className={`chip ${format === 'banner' ? 'selected' : ''}`}
                    aria-pressed={format === 'banner'}
                    onClick={() => setFormat('banner')}
                  >
                    {t('formatBanner')}
                  </button>
                </div>
                <small className="muted">{t('formatHint')}</small>
              </div>
            </div>
          ) : null}

          {/* ---------------------------------------------------- Step 2 */}
          {step === 2 ? (
            <div className="form-grid">
              {format === 'text' ? (
                <>
                  <div className="field span-2">
                    <label className="field-label" htmlFor="wz-title">
                      {t('fieldTitle')} <span className="muted">({title.trim().length}/120)</span>
                    </label>
                    <Input
                      id="wz-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder={t('fieldTitlePh')}
                      maxLength={120}
                      required
                    />
                  </div>
                  <div className="field span-2">
                    <label className="field-label" htmlFor="wz-body">
                      {t('fieldBody')} <span className="muted">({bodyText.trim().length}/500)</span>
                    </label>
                    <Textarea
                      id="wz-body"
                      value={bodyText}
                      onChange={(e) => setBodyText(e.target.value)}
                      placeholder={t('fieldBodyPh')}
                      maxLength={500}
                      rows={4}
                      required
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="field span-2">
                    <label className="field-label">{t('uploadLabel')}</label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void handleFile(file)
                      }}
                    />
                    {imageUrl ? (
                      <div className="rounded-lg border border-dashed border-chart-4/40 p-3" style={{ marginTop: 4 }}>
                        <img
                          src={imageUrl}
                          alt={altText || t('uploadLabel')}
                          className="max-h-40 w-full rounded-md object-contain"
                        />
                        <div className="row between wrap" style={{ marginTop: 8 }}>
                          <span className="tiny muted">{t('uploadDone')}</span>
                          <div className="row" style={{ gap: 8 }}>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={uploading}
                              onClick={() => fileInputRef.current?.click()}
                            >
                              <ImagePlus width={14} height={14} aria-hidden /> {t('uploadReplace')}
                            </Button>
                            <Button type="button" variant="outline" onClick={() => setImageUrl('')}>
                              <Trash2 width={14} height={14} aria-hidden /> {tc('cancel')}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="w-full rounded-lg border border-dashed border-chart-4/40 p-6 text-center"
                        disabled={uploading}
                        onClick={() => fileInputRef.current?.click()}
                        style={{ cursor: uploading ? 'wait' : 'pointer' }}
                      >
                        <span className="row" style={{ justifyContent: 'center', gap: 8 }}>
                          {uploading ? (
                            <Loader2 width={16} height={16} className="animate-spin" aria-hidden />
                          ) : (
                            <ImagePlus width={16} height={16} aria-hidden />
                          )}
                          <span className="small">{uploading ? t('uploading') : t('uploadBtn')}</span>
                        </span>
                        <span className="tiny muted" style={{ display: 'block', marginTop: 6 }}>
                          {t('uploadHint')}
                        </span>
                      </button>
                    )}
                  </div>
                  <div className="field span-2">
                    <label className="field-label" htmlFor="wz-alt">
                      {t('fieldAltText')}
                    </label>
                    <Input
                      id="wz-alt"
                      value={altText}
                      onChange={(e) => setAltText(e.target.value)}
                      placeholder={t('fieldAltTextPh')}
                      maxLength={120}
                      required
                    />
                    <small className="muted">{t('fieldAltHint')}</small>
                  </div>
                </>
              )}
              <div className="field span-2">
                <label className="field-label" htmlFor="wz-domain">
                  {t('fieldDisplayDomain')}
                </label>
                <Input
                  id="wz-domain"
                  value={displayDomain}
                  onChange={(e) => setDisplayDomain(e.target.value)}
                  placeholder={t('fieldDisplayDomainPh')}
                  maxLength={80}
                />
                <small className="muted">
                  {t('fieldDisplayDomainHint', { host: hostOf(targetUrl || 'https://example.com') })}
                </small>
              </div>
              <div className="field span-2">
                <label className="field-label" htmlFor="wz-url">
                  {t('fieldUrl')}
                </label>
                <Input
                  id="wz-url"
                  type="url"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://"
                  required
                />
              </div>
            </div>
          ) : null}

          {/* ---------------------------------------------------- Step 3 */}
          {step === 3 ? (
            <div className="form-grid">
              <div className="field span-2">
                <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Target width={14} height={14} aria-hidden /> {t('targetingTitle')}
                </label>
                <small className="muted" style={{ display: 'block', marginBottom: 12 }}>
                  {t('targetingHint')}
                </small>

                {/* Keywords */}
                <p className="tiny" style={{ marginBottom: 6 }}>
                  {t('keywordsLabel')} <span className="muted">({keywords.length}/10)</span>
                </p>
                <Input
                  value={keywordsRaw}
                  onChange={(e) => setKeywordsRaw(e.target.value)}
                  placeholder={t('keywordsPh')}
                  aria-label={t('keywordsLabel')}
                />
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <span className="tiny muted">{t('matchLabel')}:</span>
                  <button
                    type="button"
                    className={`chip ${keywordMatch === 'phrase' ? 'selected' : ''}`}
                    aria-pressed={keywordMatch === 'phrase'}
                    onClick={() => setKeywordMatch('phrase')}
                  >
                    {t('matchPhrase')}
                  </button>
                  <button
                    type="button"
                    className={`chip ${keywordMatch === 'exact' ? 'selected' : ''}`}
                    aria-pressed={keywordMatch === 'exact'}
                    onClick={() => setKeywordMatch('exact')}
                  >
                    {t('matchExact')}
                  </button>
                </div>
                <small className="muted" style={{ display: 'block', marginTop: 4 }}>
                  {t('keywordsHint')}
                </small>
              </div>

              {/* Sections */}
              <div className="field span-2" style={{ marginTop: 6 }}>
                <p className="tiny" style={{ marginBottom: 6 }}>
                  {t('targetSectionsLabel')}{' '}
                  <span className="muted">
                    ({sections.length}/{SECTION_OPTIONS.length})
                  </span>
                </p>
                <div className="row wrap" style={{ gap: 8 }}>
                  {SECTION_OPTIONS.map((s) => (
                    <button
                      type="button"
                      key={s.value}
                      className={`chip ${sections.includes(s.value) ? 'selected' : ''}`}
                      aria-pressed={sections.includes(s.value)}
                      onClick={() => setSections((prev) => toggleIn(prev, s.value))}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Languages */}
              <div className="field span-2" style={{ marginTop: 6 }}>
                <p className="tiny" style={{ marginBottom: 6 }}>
                  {t('targetLocalesLabel')}{' '}
                  <span className="muted">
                    ({locales.length}/{LOCALE_OPTIONS.length})
                  </span>
                </p>
                <div className="row wrap" style={{ gap: 8 }}>
                  {LOCALE_OPTIONS.map((l) => (
                    <button
                      type="button"
                      key={l.value}
                      className={`chip ${locales.includes(l.value) ? 'selected' : ''}`}
                      aria-pressed={locales.includes(l.value)}
                      onClick={() => setLocales((prev) => toggleIn(prev, l.value))}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Countries */}
              <div className="field span-2" style={{ marginTop: 6 }}>
                <p className="tiny" style={{ marginBottom: 6 }}>
                  {t('countriesLabel')}
                </p>
                <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
                  {(
                    [
                      ['all', t('countryModeAll')],
                      ['include', t('countryModeInclude')],
                      ['exclude', t('countryModeExclude')],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={`chip ${countryMode === value ? 'selected' : ''}`}
                      aria-pressed={countryMode === value}
                      onClick={() => setCountryMode(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {countryMode !== 'all' ? (
                  <>
                    {countries.length > 0 ? (
                      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
                        {countries.map((code) => (
                          <button
                            type="button"
                            key={code}
                            className="chip selected"
                            aria-label={`${code} — remove`}
                            onClick={() => setCountries((prev) => prev.filter((c) => c !== code))}
                          >
                            {code} · {countryName(code)} <X width={11} height={11} aria-hidden />
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <Input
                      value={countryQuery}
                      onChange={(e) => setCountryQuery(e.target.value.toUpperCase())}
                      placeholder={t('countrySearchPh')}
                      aria-label={t('countriesLabel')}
                    />
                    {countrySuggestions.length > 0 ? (
                      <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                        {countrySuggestions
                          .filter((code) => !countries.includes(code))
                          .map((code) => (
                            <button
                              type="button"
                              key={code}
                              className="chip"
                              onClick={() => {
                                setCountries((prev) =>
                                  prev.includes(code) || prev.length >= 20 ? prev : [...prev, code],
                                )
                                setCountryQuery('')
                              }}
                            >
                              + {code} · {countryName(code)}
                            </button>
                          ))}
                      </div>
                    ) : null}
                    <small className="muted" style={{ display: 'block', marginTop: 4 }}>
                      {t('countriesHint')}
                    </small>
                  </>
                ) : null}
              </div>

              {/* Hashtags */}
              <div className="field span-2" style={{ marginTop: 6 }}>
                <p className="tiny" style={{ marginBottom: 6 }}>
                  {t('hashtagsLabel')} <span className="muted">({hashtags.length}/10)</span>
                </p>
                <Input
                  value={hashtagsRaw}
                  onChange={(e) => setHashtagsRaw(e.target.value)}
                  placeholder={t('hashtagsPh')}
                  aria-label={t('hashtagsLabel')}
                />
                <small className="muted" style={{ display: 'block', marginTop: 4 }}>
                  {t('hashtagsHint')}
                </small>
              </div>
            </div>
          ) : null}

          {/* ---------------------------------------------------- Step 4 */}
          {step === 4 ? (
            <div className="form-grid">
              <div className="field span-2">
                <label className="field-label">{t('billingLabel')}</label>
                <div className="row wrap" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className={`chip ${billing === 'cpc' ? 'selected' : ''}`}
                    aria-pressed={billing === 'cpc'}
                    onClick={() => setBilling('cpc')}
                  >
                    {t('billingCpc')}
                  </button>
                  <button
                    type="button"
                    className={`chip ${billing === 'cpm' ? 'selected' : ''}`}
                    aria-pressed={billing === 'cpm'}
                    onClick={() => setBilling('cpm')}
                  >
                    {t('billingCpm')}
                  </button>
                </div>
                <small className="muted">{t('bidHint')}</small>
              </div>

              <div className="field span-2">
                <label className="field-label" htmlFor="wz-bid">
                  {t('fieldBid')} ({billing === 'cpc' ? t('bidSuffixCpc') : t('bidSuffixCpm')})
                </label>
                <div className="row wrap" style={{ gap: 8 }}>
                  {(billing === 'cpc' ? CPC_BID_CHOICES : CPM_BID_CHOICES).map((cents) => (
                    <button
                      type="button"
                      key={cents}
                      className={`chip ${dollarsToCents(bid) === cents ? 'selected' : ''}`}
                      aria-pressed={dollarsToCents(bid) === cents}
                      onClick={() => setBid((cents / 100).toFixed(2))}
                    >
                      {centsMoney(cents)}
                    </button>
                  ))}
                </div>
                <Input
                  id="wz-bid"
                  type="number"
                  min={billing === 'cpc' ? BID_BOUNDS.cpc.minCents / 100 : BID_BOUNDS.cpm.minCents / 100}
                  max={billing === 'cpc' ? BID_BOUNDS.cpc.maxCents / 100 : BID_BOUNDS.cpm.maxCents / 100}
                  step={0.01}
                  value={bid}
                  onChange={(e) => setBid(e.target.value)}
                  required
                  style={{ marginTop: 8 }}
                />
                <small className="muted">{billing === 'cpc' ? t('bidCpcBounds') : t('bidCpmBounds')}</small>
              </div>

              {!editingFunded ? (
                <div className="field span-2">
                  <label className="field-label" htmlFor="wz-budget">
                    {mode === 'create' ? t('budgetLabel') : t('budgetPlannedLabel')}
                  </label>
                  <div className="row wrap" style={{ gap: 8 }}>
                    {BUDGET_CHOICES.map((cents) => (
                      <button
                        type="button"
                        key={cents}
                        className={`chip ${dollarsToCents(budget) === cents ? 'selected' : ''}`}
                        aria-pressed={dollarsToCents(budget) === cents}
                        disabled={centsToMicro(cents) > availableMicro}
                        onClick={() => setBudget((cents / 100).toFixed(0))}
                      >
                        {centsMoney(cents)}
                      </button>
                    ))}
                  </div>
                  <Input
                    id="wz-budget"
                    type="number"
                    min={minTotalBudgetCents(billing, Number.isNaN(bidCents) ? 1 : bidCents) / 100}
                    max={Math.max(availableMicro / 10_000, 100) / 100}
                    step={0.5}
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    required
                    style={{ marginTop: 8 }}
                  />
                  <small className="muted">
                    {t('budgetWalletHint', { amount: formatMicroUsd(availableMicro) })}
                    {' · '}
                    {billing === 'cpc'
                      ? t('estClicks', {
                          count: budgetEventEstimate('cpc', Number.isNaN(budgetCents) ? 0 : budgetCents, Number.isNaN(bidCents) ? 1 : bidCents),
                        })
                      : t('estViews', {
                          count: budgetEventEstimate('cpm', Number.isNaN(budgetCents) ? 0 : budgetCents, Number.isNaN(bidCents) ? 1 : bidCents),
                        })}
                  </small>
                </div>
              ) : (
                <div className="field span-2">
                  <label className="field-label">{t('budgetLabel')}</label>
                  <p className="small" style={{ marginTop: 2 }}>
                    <strong>{formatMicroUsd(campaign?.totalBudgetMicroUsd ?? 0)}</strong>{' '}
                    <span className="muted">· {t('budgetLocked')}</span>
                  </p>
                </div>
              )}

              <div className="field span-2">
                <label className="field-label" htmlFor="wz-daily">
                  {t('dailyBudgetLabel')}
                </label>
                <div className="row wrap" style={{ gap: 8 }}>
                  {DAILY_CHOICES.map((cents) => (
                    <button
                      type="button"
                      key={cents}
                      className={`chip ${dollarsToCents(daily || '0') === cents ? 'selected' : ''}`}
                      aria-pressed={dollarsToCents(daily || '0') === cents}
                      onClick={() => setDaily(cents === 0 ? '0' : (cents / 100).toFixed(2))}
                    >
                      {cents === 0 ? t('dailyNoCap') : centsMoney(cents)}
                    </button>
                  ))}
                </div>
                <Input
                  id="wz-daily"
                  type="number"
                  min={0}
                  step={0.5}
                  value={daily}
                  onChange={(e) => setDaily(e.target.value)}
                  style={{ marginTop: 8 }}
                />
                <small className="muted">{t('dailyBudgetHint')}</small>
              </div>

              {/* Phase 4 — the delivery forecast box: what this campaign can
                  expect per day, from the last 7 days of real delivery
                  filtered by the Step-3 targeting (sections + languages).
                  The honest fallback — "Insufficient data to forecast" — is
                  shown until the platform has ≥ 1000 impressions in the
                  window; never an invented number. */}
              <div
                className="field span-2"
                style={{ marginTop: 4, padding: 14, border: '1px dashed var(--chart-4, #8b9dc3)', borderRadius: 10 }}
              >
                <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <TrendingUp width={15} height={15} aria-hidden />
                  {t('forecastTitle')}
                </label>
                {forecast.state === 'loading' ? (
                  <p className="muted small" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Loader2 width={14} height={14} className="animate-spin" aria-hidden />
                    {t('forecastLoading')}
                  </p>
                ) : forecast.state === 'error' ? (
                  <p className="muted small" style={{ marginTop: 6 }}>
                    {forecast.message}
                  </p>
                ) : !forecast.sufficient ? (
                  <div style={{ marginTop: 6 }}>
                    <p className="small">
                      <strong>{t('forecastInsufficient')}</strong>
                    </p>
                    <p className="muted tiny" style={{ marginTop: 4 }}>
                      {t('forecastInsufficientHint')}
                    </p>
                  </div>
                ) : (
                  <div style={{ marginTop: 6 }}>
                    <p className="small">
                      <strong>
                        {forecast.dailyImpressions
                          ? t('forecastImpressions', {
                              low: forecast.dailyImpressions.low,
                              high: forecast.dailyImpressions.high,
                            })
                          : '—'}
                      </strong>
                      {forecast.dailyClicks
                        ? ` · ${t('forecastClicks', {
                            low: forecast.dailyClicks.low,
                            high: forecast.dailyClicks.high,
                          })}`
                        : ''}
                    </p>
                    <p className="muted tiny" style={{ marginTop: 4 }}>
                      {t('forecastNote', { days: 7 })}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {/* ---------------------------------------------------- Step 5 */}
          {step === 5 ? (
            <div>
              <h4 style={{ marginBottom: 10 }}>{t('summaryTitle')}</h4>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {(
                      [
                        [1, t('fieldCampaignName'), name || '—'],
                        [
                          1,
                          t('formatLabel'),
                          format === 'text' ? t('formatText') : t('formatBanner'),
                        ],
                        [
                          2,
                          format === 'text' ? t('fieldTitle') : t('uploadLabel'),
                          format === 'text' ? title : imageUrl ? t('uploadDone') : '—',
                        ],
                        ...(format === 'text'
                          ? ([[2, t('fieldBody'), bodyText]] as const)
                          : ([[2, t('fieldAltText'), altText]] as const)),
                        [2, t('fieldDisplayDomain'), displayDomain || hostOf(targetUrl)],
                        [2, t('fieldUrl'), targetUrl],
                        [
                          3,
                          t('keywordsLabel'),
                          keywords.length > 0
                            ? `${keywords.join(', ')} (${keywordMatch === 'exact' ? t('matchExact') : t('matchPhrase')})`
                            : t('targetsAll'),
                        ],
                        [
                          3,
                          t('targetSectionsLabel'),
                          sections.length > 0
                            ? sections.map((s) => SECTION_META[s as keyof typeof SECTION_META]?.title ?? s).join(', ')
                            : t('targetsAll'),
                        ],
                        [
                          3,
                          t('targetLocalesLabel'),
                          locales.length > 0 ? locales.join(', ') : t('targetsAll'),
                        ],
                        [
                          3,
                          t('countriesLabel'),
                          countryMode === 'all'
                            ? t('countryModeAll')
                            : `${countryMode === 'include' ? t('countryModeInclude') : t('countryModeExclude')} ${countries.join(', ')}`,
                        ],
                        [
                          3,
                          t('hashtagsLabel'),
                          hashtags.length > 0 ? hashtags.map((h) => `#${h}`).join(', ') : t('targetsAll'),
                        ],
                        [
                          4,
                          t('billingLabel'),
                          billing === 'cpc' ? t('billingCpc') : t('billingCpm'),
                        ],
                        [
                          4,
                          t('fieldBid'),
                          billing === 'cpc'
                            ? t('bidLineCpc', { amount: formatMicroUsd(centsToMicro(bidCents || 0)) })
                            : t('bidLineCpm', { amount: formatMicroUsd(centsToMicro(bidCents || 0)) }),
                        ],
                        [
                          4,
                          editingFunded ? t('budgetLabel') : mode === 'create' ? t('budgetLabel') : t('budgetPlannedLabel'),
                          formatMicroUsd(centsToMicro(editingFunded ? (campaign?.totalBudgetMicroUsd ?? 0) : budgetCents || 0)),
                        ],
                        [
                          4,
                          t('dailyBudgetLabel'),
                          dailyCents === 0 ? t('dailyNoCap') : formatMicroUsd(centsToMicro(dailyCents)),
                        ],
                      ] as const
                    ).map(([stepOf, label, value], i) => (
                      <tr key={i} className="data-row">
                        <td className="muted" style={{ width: '38%' }}>
                          {label}
                          <button
                            type="button"
                            className="chip"
                            style={{ marginLeft: 8, padding: '1px 8px' }}
                            onClick={() => setStep(stepOf)}
                          >
                            {t('summaryEdit')}
                          </button>
                        </td>
                        <td>{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small" style={{ marginTop: 12, lineHeight: 1.7 }}>
                {canSubmit ? t('summarySubmitHint') : wasApproved ? t('wizardRevisionNote') : t('summaryPendingHint')}
              </p>
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="negative small" role="alert" style={{ marginTop: 12 }}>
            {error}
          </p>
        ) : null}

        {/* Footer navigation */}
        <div className="row between wrap" style={{ gap: 10, marginTop: 18 }}>
          <div className="row" style={{ gap: 8 }}>
            {step > 1 ? (
              <Button type="button" variant="outline" onClick={goBack}>
                <ArrowLeft width={15} height={15} aria-hidden /> {t('btnBack')}
              </Button>
            ) : null}
            {step < TOTAL_STEPS ? (
              <Button type="button" onClick={goNext}>
                {t('btnNext')} <ArrowRight width={15} height={15} aria-hidden />
              </Button>
            ) : null}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={saveDraft}>
              <Save width={15} height={15} aria-hidden />
              {busy === 'draft' ? tc('loading') : t('btnSaveDraft')}
            </Button>
            {canSubmit || wasApproved ? (
              <Button
                type="button"
                disabled={busy !== null}
                onClick={canSubmit ? submitForReview : saveDraft}
              >
                <Send width={15} height={15} aria-hidden />
                {busy === 'submit'
                  ? tc('loading')
                  : canSubmit
                    ? t('btnSubmitReview')
                    : t('btnSaveChanges')}
              </Button>
            ) : (
              <Button type="button" disabled={busy !== null} onClick={saveDraft}>
                <Save width={15} height={15} aria-hidden />
                {busy === 'draft' ? tc('loading') : t('btnSaveChanges')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
