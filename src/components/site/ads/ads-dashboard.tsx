'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Megaphone, PencilLine, Plus, Target, Wallet, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api-client'
import { LANGUAGES, POST_SECTIONS, SECTION_META } from '@/lib/constants'

/**
 * Advertiser dashboard — the "Merklane ADS" tab of the profile cabinet.
 *
 * Two sub-sections (the UX fix: money and campaigns are never mixed):
 *   Wallet    deposit with crypto (BlockBee), watch the balance and the
 *             deposit history. No campaign controls live here.
 *   Campaigns the campaign list + "Create campaign". Creation asks for the
 *             bid, the TARGETING (sections / languages) and an initial
 *             budget which is validated against — and drawn from — the
 *             wallet. "Add funds" moves more wallet money into a campaign.
 *
 * Flow: fund the wallet first, then create campaigns. A fresh advertiser
 * (no campaigns yet) lands on the Wallet tab; once campaigns exist the
 * Campaigns tab opens first.
 *
 * Styling deliberately sticks to the legacy template vocabulary (card,
 * stat-grid, chip, badge, field, table-wrap) plus standard Tailwind
 * utilities, so it stays native to the restored original design.
 */

interface Campaign {
  id: string
  title: string
  body: string
  ctaUrl: string
  ctaLabel: string | null
  balance: number
  bidPerView: number
  status: 'active' | 'paused' | 'ended' | string
  createdAt: string
  impressions: number
  clicks: number
  targetSections: string[]
  targetLocales: string[]
}

interface TopUpRow {
  id: string
  status: 'pending' | 'confirmed' | 'expired' | string
  amountExpectedCents: number
  amountReceivedCents: number
  provider: 'blockbee' | 'manual' | string
  coin: string | null
  txHash: string | null
  createdAt: string
  confirmedAt: string | null
}

interface WalletData {
  balanceCents: number
  inCampaignsCents: number
  pendingCents: number
  topUps: TopUpRow[]
  topUp: { mode: string; coins: string[]; minCents: number; maxCents: number }
}

/** Active deposit intention (modal state — includes the address). */
interface ActiveDeposit {
  id: string
  status: 'pending' | 'confirmed' | 'expired' | string
  walletAddress: string
  amountExpectedCents: number
  provider: 'blockbee' | 'manual' | string
  coin: string | null
  mode: string
}

const BID_CHOICES = [1, 2, 3, 5, 10] // US cents per view
const BUDGET_CHOICES = [100, 500, 1000, 2500] // US cents initial budget

/** Minimum initial budget at a bid (mirrors src/lib/ads/wallet.ts). */
function minBudgetCents(bid: number): number {
  return Math.max(100, Math.max(1, bid) * 50)
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Pretty label for a BlockBee ticker (polygon_usdt → USDT · Polygon). */
function coinLabel(coin: string): string {
  const [network, token] = coin.includes('_') ? coin.split('_') : [null, coin]
  if (!network) return coin.toUpperCase()
  const net =
    network === 'polygon'
      ? 'Polygon'
      : network === 'bep20'
        ? 'BSC'
        : network === 'erc20'
          ? 'Ethereum'
          : network === 'arbitrum'
            ? 'Arbitrum'
            : network.toUpperCase()
  return `${(token ?? coin).toUpperCase()} · ${net}`
}

const SECTION_OPTIONS = POST_SECTIONS.map((s) => ({ value: s, label: SECTION_META[s].title }))
const LOCALE_OPTIONS = LANGUAGES.map((l) => ({ value: l.code, label: l.native }))

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

type AdsView = 'wallet' | 'campaigns'

export function AdsDashboard() {
  const t = useTranslations('ads')
  const tc = useTranslations('common')

  const [view, setView] = useState<AdsView>('wallet')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [wallet, setWallet] = useState<WalletData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // First-load view decision, computed once (see refresh below).
  const viewDecided = useRef(false)

  // ------------------------------------------------------------- data loads
  const refresh = useCallback(async () => {
    try {
      const [campData, walletData] = await Promise.all([
        api<{ campaigns: Campaign[] }>('/api/ads/campaigns'),
        api<WalletData>('/api/ads/wallet'),
      ])
      setCampaigns(campData.campaigns)
      setWallet(walletData)
      setError(null)
      // Wallet-first onboarding: an advertiser with no campaigns yet lands
      // on the Wallet tab so the deposit happens BEFORE any bid is set.
      // Returning advertisers go straight to their campaigns.
      if (!viewDecided.current) {
        viewDecided.current = true
        setView(campData.campaigns.length > 0 ? 'campaigns' : 'wallet')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setLoaded(true)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ---------------------------------------------------------------- modals
  // Deposit (BlockBee) — opened from the Wallet tab
  const [depositOpen, setDepositOpen] = useState(false)
  const [amount, setAmount] = useState('10')
  const [coin, setCoin] = useState('')
  const [activeDeposit, setActiveDeposit] = useState<ActiveDeposit | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Coin preselect once the wallet config arrives (stablecoin-first order)
  useEffect(() => {
    if (!wallet) return
    setCoin((prev) => (prev && wallet.topUp.coins.includes(prev) ? prev : (wallet.topUp.coins[0] ?? prev)))
  }, [wallet])

  // Campaign create/edit form
  const [formOpen, setFormOpen] = useState<null | { mode: 'create' } | { mode: 'edit'; campaign: Campaign }>(null)
  const [fTitle, setFTitle] = useState('')
  const [fBody, setFBody] = useState('')
  const [fUrl, setFUrl] = useState('')
  const [fBid, setFBid] = useState(1)
  const [fBudget, setFBudget] = useState('5')
  const [fSections, setFSections] = useState<string[]>([])
  const [fLocales, setFLocales] = useState<string[]>([])
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Add funds (wallet → campaign budget)
  const [fundFor, setFundFor] = useState<Campaign | null>(null)
  const [fundAmount, setFundAmount] = useState('5')
  const [fundBusy, setFundBusy] = useState(false)
  const [fundError, setFundError] = useState<string | null>(null)

  // ------------------------------------------------------------- deposit io
  useEffect(() => {
    if (!activeDeposit || activeDeposit.status !== 'pending') return
    pollRef.current = setInterval(async () => {
      try {
        const data = await api<ActiveDeposit>(`/api/ads/topups/${activeDeposit.id}`)
        setActiveDeposit((prev) => (prev && prev.id === data.id ? data : prev))
        if (data.status === 'confirmed') void refresh()
      } catch {
        // polling errors are non-fatal; the next tick retries
      }
    }, 4000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [activeDeposit, refresh])

  function closeDeposit() {
    if (pollRef.current) clearInterval(pollRef.current)
    setDepositOpen(false)
    setActiveDeposit(null)
    setCopied(false)
  }

  async function startDeposit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const cents = Math.round(Number.parseFloat(amount) * 100)
      const isBlockbee = wallet?.topUp.mode === 'blockbee'
      const data = await api<ActiveDeposit>('/api/ads/topups', {
        method: 'POST',
        body: {
          amountCents: cents,
          ...(isBlockbee ? { coin } : {}),
        },
      })
      setActiveDeposit(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  async function simulatePayment() {
    if (!activeDeposit) return
    setError(null)
    try {
      await api(`/api/ads/topups/${activeDeposit.id}/simulate`, { method: 'POST' })
      const data = await api<ActiveDeposit>(`/api/ads/topups/${activeDeposit.id}`)
      setActiveDeposit(data)
      if (data.status === 'confirmed') void refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    }
  }

  // ------------------------------------------------------------ campaign io
  function openCreate() {
    setFTitle('')
    setFBody('')
    setFUrl('')
    setFBid(1)
    setFBudget('5')
    setFSections([])
    setFLocales([])
    setFormError(null)
    setFormOpen({ mode: 'create' })
  }

  function openEdit(c: Campaign) {
    setFTitle(c.title)
    setFBody(c.body)
    setFUrl(c.ctaUrl)
    setFBid(c.bidPerView)
    setFBudget(String((c.balance / 100).toFixed(2)))
    setFSections(c.targetSections)
    setFLocales(c.targetLocales)
    setFormError(null)
    setFormOpen({ mode: 'edit', campaign: c })
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault()
    if (!formOpen) return
    setFormError(null)

    const budgetCents = Math.round(Number.parseFloat(fBudget) * 100)
    if (formOpen.mode === 'create') {
      const min = minBudgetCents(fBid)
      if (!Number.isFinite(budgetCents) || budgetCents < min) {
        setFormError(t('budgetMinHint', { min: money(min) }))
        return
      }
      if (wallet && budgetCents > wallet.balanceCents) {
        setFormError(t('insufficientWallet'))
        return
      }
    }

    setFormBusy(true)
    try {
      if (formOpen.mode === 'create') {
        await api('/api/ads/campaigns', {
          method: 'POST',
          body: {
            title: fTitle,
            body: fBody,
            ctaUrl: fUrl,
            bidPerView: fBid,
            budgetCents,
            targetSections: fSections,
            targetLocales: fLocales,
          },
        })
      } else {
        await api(`/api/ads/campaigns/${formOpen.campaign.id}`, {
          method: 'PATCH',
          body: {
            action: 'update',
            title: fTitle,
            body: fBody,
            ctaUrl: fUrl,
            bidPerView: fBid,
            targetSections: fSections,
            targetLocales: fLocales,
          },
        })
      }
      setFormOpen(null)
      await refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setFormBusy(false)
    }
  }

  async function toggleCampaign(c: Campaign) {
    setError(null)
    try {
      await api(`/api/ads/campaigns/${c.id}`, {
        method: 'PATCH',
        body: { action: c.status === 'active' ? 'pause' : 'resume' },
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    }
  }

  function openFund(c: Campaign) {
    setFundFor(c)
    setFundAmount('5')
    setFundError(null)
  }

  async function submitFund(e: React.FormEvent) {
    e.preventDefault()
    if (!fundFor) return
    setFundError(null)
    const cents = Math.round(Number.parseFloat(fundAmount) * 100)
    if (!Number.isFinite(cents) || cents < 100) {
      setFundError(t('fundMinHint'))
      return
    }
    if (wallet && cents > wallet.balanceCents) {
      setFundError(t('insufficientWallet'))
      return
    }
    setFundBusy(true)
    try {
      await api(`/api/ads/campaigns/${fundFor.id}`, {
        method: 'PATCH',
        body: { action: 'fund', amountCents: cents },
      })
      setFundFor(null)
      await refresh()
    } catch (err) {
      setFundError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setFundBusy(false)
    }
  }

  // ------------------------------------------------------------------ render
  const walletCents = wallet?.balanceCents ?? 0

  return (
    <div>
      {/* Sub-tab bar — Wallet | Campaigns */}
      <div className="row between wrap" style={{ gap: 14, marginBottom: 20 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <Megaphone width={20} height={20} aria-hidden />
          Merklane ADS
        </h2>
        <div className="row" style={{ gap: 6 }} role="tablist" aria-label="Ads sections">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'wallet'}
            className={`chip ${view === 'wallet' ? 'selected' : ''}`}
            onClick={() => setView('wallet')}
          >
            <Wallet width={14} height={14} aria-hidden /> {t('tabWallet')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'campaigns'}
            className={`chip ${view === 'campaigns' ? 'selected' : ''}`}
            onClick={() => setView('campaigns')}
          >
            <Megaphone width={14} height={14} aria-hidden /> {t('tabCampaigns')}
          </button>
        </div>
      </div>

      {error ? (
        <p className="negative small" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </p>
      ) : null}

      {view === 'wallet' ? (
        <WalletView
          wallet={wallet}
          loaded={loaded}
          onDeposit={() => {
            setActiveDeposit(null)
            setDepositOpen(true)
          }}
        />
      ) : (
        <CampaignsView
          campaigns={campaigns}
          loaded={loaded}
          walletCents={walletCents}
          onCreate={openCreate}
          onEdit={openEdit}
          onFund={openFund}
          onToggle={toggleCampaign}
        />
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Deposit modal (BlockBee / manual)                                */}
      {/* ---------------------------------------------------------------- */}
      {depositOpen ? (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-5 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('topUpTitle')}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDeposit()
          }}
        >
          <div className="card w-full max-w-[480px] shadow-2xl">
            <div className="row between">
              <h3>{t('topUpTitle')}</h3>
              <button type="button" className="icon-button" aria-label={tc('cancel')} onClick={closeDeposit}>
                <X width={16} height={16} aria-hidden />
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 4 }}>
              {t('walletBalanceLabel')}: <strong>{money(walletCents)}</strong>
            </p>

            {!activeDeposit ? (
              <form onSubmit={startDeposit} style={{ marginTop: 16 }}>
                {wallet?.topUp.mode === 'blockbee' && wallet.topUp.coins.length > 0 ? (
                  <div className="field" style={{ marginBottom: 14 }}>
                    <label className="field-label">{t('topUpCoin')}</label>
                    <div className="row wrap" style={{ gap: 8 }}>
                      {wallet.topUp.coins.map((c) => (
                        <button
                          type="button"
                          key={c}
                          className={`chip ${coin === c ? 'selected' : ''}`}
                          aria-pressed={coin === c}
                          onClick={() => setCoin(c)}
                        >
                          {coinLabel(c)}
                        </button>
                      ))}
                    </div>
                    <small className="muted">{t('topUpCoinNote')}</small>
                  </div>
                ) : null}
                <div className="field">
                  <label className="field-label" htmlFor="ad-amount">
                    {t('topUpAmount')}
                  </label>
                  <Input
                    id="ad-amount"
                    type="number"
                    min={5}
                    max={5000}
                    step={1}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                  <small className="muted">{t('topUpMin')}</small>
                </div>
                <div className="button-row" style={{ marginTop: 14 }}>
                  <Button type="submit" disabled={busy || (wallet?.topUp.mode === 'blockbee' && !coin)}>
                    {busy ? tc('loading') : t('topUpCreate')}
                  </Button>
                </div>
              </form>
            ) : (
              <div style={{ marginTop: 16 }}>
                <div className="rounded-lg border border-dashed border-chart-4/40 p-3.5">
                  <p className="tiny muted">
                    {activeDeposit.provider === 'blockbee' && activeDeposit.coin
                      ? `${t('topUpAddress')} — ${coinLabel(activeDeposit.coin)}`
                      : t('topUpAddress')}
                  </p>
                  <code className="mt-2 block break-all rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
                    {activeDeposit.walletAddress}
                  </code>
                  <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(activeDeposit.walletAddress).then(() => {
                          setCopied(true)
                          setTimeout(() => setCopied(false), 2000)
                        })
                      }}
                    >
                      {copied ? tc('copied') : t('copyAddress')}
                    </Button>
                    {activeDeposit.mode === 'simulate' && activeDeposit.status === 'pending' ? (
                      <Button type="button" onClick={simulatePayment}>
                        {t('topUpSimulate')}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="muted small" style={{ marginTop: 12 }}>
                  {t('topUpExpected')} <strong>{money(activeDeposit.amountExpectedCents)}</strong>
                  {activeDeposit.provider === 'blockbee' && activeDeposit.coin ? ` · ${coinLabel(activeDeposit.coin)}` : ''}
                </p>
                <p
                  className={`small ${activeDeposit.status === 'confirmed' ? 'positive' : 'muted'}`}
                  role="status"
                  style={{ marginTop: 8 }}
                >
                  {activeDeposit.status === 'confirmed'
                    ? t('topUpConfirmed')
                    : activeDeposit.provider === 'blockbee'
                      ? t('topUpBlockbeeNote')
                      : activeDeposit.mode === 'simulate'
                        ? t('topUpSimulateNote')
                        : t('topUpManualNote')}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Create / Edit campaign modal (bid + budget + TARGETING)          */}
      {/* ---------------------------------------------------------------- */}
      {formOpen ? (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-5 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={formOpen.mode === 'create' ? t('createTitle') : t('editTitle')}
          onClick={(e) => {
            if (e.target === e.currentTarget) setFormOpen(null)
          }}
        >
          <div className="card w-full max-w-[560px] shadow-2xl" style={{ maxHeight: '90svh', overflowY: 'auto' }}>
            <div className="row between">
              <h3>{formOpen.mode === 'create' ? t('createTitle') : t('editTitle')}</h3>
              <button type="button" className="icon-button" aria-label={tc('cancel')} onClick={() => setFormOpen(null)}>
                <X width={16} height={16} aria-hidden />
              </button>
            </div>

            <form onSubmit={submitForm} style={{ marginTop: 14 }}>
              <div className="form-grid">
                <div className="field">
                  <label className="field-label" htmlFor="ad-title">
                    {t('fieldTitle')}
                  </label>
                  <Input
                    id="ad-title"
                    value={fTitle}
                    onChange={(e) => setFTitle(e.target.value)}
                    placeholder={t('fieldTitlePh')}
                    maxLength={80}
                    required
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="ad-url">
                    {t('fieldUrl')}
                  </label>
                  <Input
                    id="ad-url"
                    type="url"
                    value={fUrl}
                    onChange={(e) => setFUrl(e.target.value)}
                    placeholder="https://"
                    required
                  />
                </div>
                <div className="field span-2">
                  <label className="field-label" htmlFor="ad-body">
                    {t('fieldBody')}
                  </label>
                  <Textarea
                    id="ad-body"
                    value={fBody}
                    onChange={(e) => setFBody(e.target.value)}
                    placeholder={t('fieldBodyPh')}
                    maxLength={200}
                    rows={3}
                    required
                  />
                </div>
                <div className="field span-2">
                  <label className="field-label">{t('fieldBid')}</label>
                  <div className="row wrap" style={{ gap: 8 }}>
                    {BID_CHOICES.map((cents) => (
                      <button
                        type="button"
                        key={cents}
                        className={`chip ${fBid === cents ? 'selected' : ''}`}
                        aria-pressed={fBid === cents}
                        onClick={() => setFBid(cents)}
                      >
                        {t('bidChip', { cents })}
                      </button>
                    ))}
                  </div>
                  <small className="muted">{t('bidHint')}</small>
                </div>

                {formOpen.mode === 'create' ? (
                  <div className="field span-2">
                    <label className="field-label" htmlFor="ad-budget">
                      {t('budgetLabel')}
                    </label>
                    <div className="row wrap" style={{ gap: 8 }}>
                      {BUDGET_CHOICES.map((cents) => (
                        <button
                          type="button"
                          key={cents}
                          className={`chip ${Math.round(Number.parseFloat(fBudget) * 100) === cents ? 'selected' : ''}`}
                          aria-pressed={Math.round(Number.parseFloat(fBudget) * 100) === cents}
                          disabled={cents > walletCents}
                          onClick={() => setFBudget((cents / 100).toFixed(0))}
                        >
                          {money(cents)}
                        </button>
                      ))}
                    </div>
                    <Input
                      id="ad-budget"
                      type="number"
                      min={minBudgetCents(fBid) / 100}
                      max={Math.max(walletCents, minBudgetCents(fBid)) / 100}
                      step={0.5}
                      value={fBudget}
                      onChange={(e) => setFBudget(e.target.value)}
                      required
                      style={{ marginTop: 8 }}
                    />
                    <small className="muted">
                      {t('budgetWalletHint', { amount: money(walletCents) })} ·{' '}
                      {t('budgetViews', { count: Math.floor((Math.round(Number.parseFloat(fBudget) * 100) || 0) / fBid) })}
                    </small>
                  </div>
                ) : null}

                {/* ------------------------- Targeting ------------------------ */}
                <div className="field span-2" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Target width={14} height={14} aria-hidden /> {t('targetingTitle')}
                  </label>
                  <small className="muted" style={{ display: 'block', marginBottom: 10 }}>
                    {t('targetingHint')}
                  </small>

                  <p className="tiny" style={{ marginBottom: 6 }}>
                    {t('targetSectionsLabel')}{' '}
                    <span className="muted">
                      ({fSections.length}/{SECTION_OPTIONS.length})
                    </span>
                  </p>
                  <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
                    {SECTION_OPTIONS.map((s) => (
                      <button
                        type="button"
                        key={s.value}
                        className={`chip ${fSections.includes(s.value) ? 'selected' : ''}`}
                        aria-pressed={fSections.includes(s.value)}
                        onClick={() => setFSections((prev) => toggleIn(prev, s.value))}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  <p className="tiny" style={{ marginBottom: 6 }}>
                    {t('targetLocalesLabel')}{' '}
                    <span className="muted">
                      ({fLocales.length}/{LOCALE_OPTIONS.length})
                    </span>
                  </p>
                  <div className="row wrap" style={{ gap: 8 }}>
                    {LOCALE_OPTIONS.map((l) => (
                      <button
                        type="button"
                        key={l.value}
                        className={`chip ${fLocales.includes(l.value) ? 'selected' : ''}`}
                        aria-pressed={fLocales.includes(l.value)}
                        onClick={() => setFLocales((prev) => toggleIn(prev, l.value))}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {formError ? (
                <p className="negative small" role="alert" style={{ marginTop: 12 }}>
                  {formError}
                </p>
              ) : null}

              <div className="button-row" style={{ marginTop: 18 }}>
                <Button type="submit" disabled={formBusy}>
                  {formOpen.mode === 'create' ? (
                    <>
                      <Plus width={15} height={15} aria-hidden /> {formBusy ? tc('loading') : t('createBtn')}
                    </>
                  ) : (
                    <>
                      <PencilLine width={15} height={15} aria-hidden /> {formBusy ? tc('loading') : t('saveBtn')}
                    </>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Add funds modal (wallet → campaign budget)                       */}
      {/* ---------------------------------------------------------------- */}
      {fundFor ? (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-5 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('fundTitle')}
          onClick={(e) => {
            if (e.target === e.currentTarget) setFundFor(null)
          }}
        >
          <div className="card w-full max-w-[440px] shadow-2xl">
            <div className="row between">
              <h3>{t('fundTitle')}</h3>
              <button type="button" className="icon-button" aria-label={tc('cancel')} onClick={() => setFundFor(null)}>
                <X width={16} height={16} aria-hidden />
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 4 }}>
              {fundFor.title} · {t('balance')} {money(fundFor.balance)}
            </p>
            <p className="muted tiny" style={{ marginTop: 6 }}>
              {t('fundNote', { amount: money(walletCents) })}
            </p>

            <form onSubmit={submitFund} style={{ marginTop: 14 }}>
              <div className="field">
                <label className="field-label" htmlFor="ad-fund">
                  {t('topUpAmount')}
                </label>
                <Input
                  id="ad-fund"
                  type="number"
                  min={1}
                  max={Math.max(walletCents / 100, 1)}
                  step={0.5}
                  value={fundAmount}
                  onChange={(e) => setFundAmount(e.target.value)}
                  required
                />
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setFundAmount((walletCents / 100).toFixed(2))}
                    disabled={walletCents < 100}
                  >
                    {t('fundAll')}
                  </Button>
                </div>
              </div>
              {fundError ? (
                <p className="negative small" role="alert" style={{ marginTop: 10 }}>
                  {fundError}
                </p>
              ) : null}
              <div className="button-row" style={{ marginTop: 14 }}>
                <Button type="submit" disabled={fundBusy}>
                  {fundBusy ? tc('loading') : t('fundBtn')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wallet sub-tab
// ---------------------------------------------------------------------------

function WalletView({
  wallet,
  loaded,
  onDeposit,
}: {
  wallet: WalletData | null
  loaded: boolean
  onDeposit: () => void
}) {
  const t = useTranslations('ads')

  if (!loaded && !wallet) {
    return <p className="muted small">Loading…</p>
  }

  return (
    <div>
      <div className="stat-grid">
        <div className="stat">
          <p className="label">{t('walletBalanceLabel')}</p>
          <p className="value">{money(wallet?.balanceCents ?? 0)}</p>
          <p className="detail">{t('walletHint')}</p>
        </div>
        <div className="stat">
          <p className="label">{t('inCampaignsLabel')}</p>
          <p className="value">{money(wallet?.inCampaignsCents ?? 0)}</p>
          <p className="detail">{t('inCampaignsDetail')}</p>
        </div>
        <div className="stat">
          <p className="label">{t('pendingLabel')}</p>
          <p className="value">{money(wallet?.pendingCents ?? 0)}</p>
          <p className="detail">{t('pendingDetail')}</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="row between wrap" style={{ gap: 12 }}>
          <div style={{ minWidth: 220, flex: 1 }}>
            <h3>{t('topUpWallet')}</h3>
            <p className="muted small" style={{ marginTop: 6, lineHeight: 1.7 }}>
              {t('topUpWalletText')}
            </p>
          </div>
          <Button onClick={onDeposit}>
            <Wallet width={15} height={15} aria-hidden />
            {t('topUpWallet')}
          </Button>
        </div>
      </div>

      {/* Transaction history */}
      <div className="section-block" style={{ marginTop: 18 }}>
        <div className="section-title">
          <h2>{t('historyTitle')}</h2>
        </div>
        {(wallet?.topUps.length ?? 0) === 0 ? (
          <div className="empty-state card" style={{ textAlign: 'center' }}>
            <h3>{t('historyEmpty')}</h3>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('colDate')}</th>
                  <th>{t('colAmount')}</th>
                  <th>{t('colNetwork')}</th>
                  <th>{t('colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {wallet?.topUps.map((row) => (
                  <tr key={row.id} className="data-row">
                    <td className="muted">{new Date(row.createdAt).toLocaleDateString()}</td>
                    <td>
                      {row.status === 'confirmed' && row.amountReceivedCents > 0
                        ? money(row.amountReceivedCents)
                        : money(row.amountExpectedCents)}
                    </td>
                    <td className="muted">{row.coin ? coinLabel(row.coin) : row.provider === 'blockbee' ? 'BlockBee' : '—'}</td>
                    <td>
                      <span
                        className={`badge ${
                          row.status === 'confirmed' ? 'state-active' : row.status === 'pending' ? 'state-under-review' : 'state-draft'
                        }`}
                      >
                        {row.status === 'confirmed'
                          ? t('statusConfirmed')
                          : row.status === 'pending'
                            ? t('statusPending')
                            : t('statusExpired')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Campaigns sub-tab
// ---------------------------------------------------------------------------

function CampaignsView({
  campaigns,
  loaded,
  walletCents,
  onCreate,
  onEdit,
  onFund,
  onToggle,
}: {
  campaigns: Campaign[]
  loaded: boolean
  walletCents: number
  onCreate: () => void
  onEdit: (c: Campaign) => void
  onFund: (c: Campaign) => void
  onToggle: (c: Campaign) => void
}) {
  const t = useTranslations('ads')
  const tc = useTranslations('common')

  return (
    <div>
      <div className="row between wrap" style={{ gap: 12, marginBottom: 14 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>{t('yourCampaigns')}</h2>
          <p className="muted small">
            {campaigns.length > 0 ? t('campaignCount', { count: campaigns.length }) : null}
          </p>
        </div>
        <Button onClick={onCreate}>
          <Plus width={15} height={15} aria-hidden />
          {t('newCampaignBtn')}
        </Button>
      </div>

      {!loaded ? (
        <p className="muted small">{tc('loading')}</p>
      ) : campaigns.length === 0 ? (
        <div className="empty-state card" style={{ textAlign: 'center' }}>
          <h3>{t('noCampaigns')}</h3>
          <p className="muted small" style={{ marginTop: 8 }}>
            {t('noCampaignsText')}
          </p>
          <div className="button-row" style={{ justifyContent: 'center', marginTop: 16 }}>
            <Button onClick={onCreate} disabled={walletCents < 100}>
              <Plus width={15} height={15} aria-hidden />
              {t('newCampaignBtn')}
            </Button>
          </div>
          {walletCents < 100 ? (
            <p className="muted tiny" style={{ marginTop: 10 }}>
              {t('insufficientWallet')}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-4">
          {campaigns.map((c) => {
            const ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : null
            const resumable = c.status === 'paused' && c.balance >= c.bidPerView
            const targets = [
              c.targetSections.length > 0
                ? `${c.targetSections.length}/${SECTION_OPTIONS.length} ${t('targetSectionsLabel')}`
                : null,
              c.targetLocales.length > 0
                ? `${c.targetLocales.length}/${LOCALE_OPTIONS.length} ${t('targetLocalesLabel')}`
                : null,
            ].filter(Boolean)
            return (
              <div className="card ads-campaign" key={c.id}>
                <div className="row between wrap" style={{ gap: 10 }}>
                  <strong className="text-[1.05rem] tracking-tight">{c.title}</strong>
                  <span
                    className={`badge ${
                      c.status === 'active'
                        ? 'state-active'
                        : c.status === 'paused'
                          ? 'state-draft'
                          : 'state-under-review'
                    }`}
                  >
                    {c.status === 'active' ? t('statusActive') : c.status === 'paused' ? t('statusPaused') : t('statusEnded')}
                  </span>
                </div>
                <p className="muted small" style={{ marginTop: 6 }}>
                  {c.body}
                </p>
                <p className="tiny muted" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Target width={12} height={12} aria-hidden />
                  {targets.length === 0 ? t('targetsAll') : targets.join(' · ')} · {hostOf(c.ctaUrl)} ·{' '}
                  {t('bidPerViewLabel', { cents: c.bidPerView })}
                </p>
                <div className="stat-grid" style={{ marginTop: 14 }}>
                  <div className="stat">
                    <p className="label">{t('balance')}</p>
                    <p className="value">{money(c.balance)}</p>
                  </div>
                  <div className="stat">
                    <p className="label">{t('impressions')}</p>
                    <p className="value">{c.impressions}</p>
                  </div>
                  <div className="stat">
                    <p className="label">{t('clicks')}</p>
                    <p className="value">{c.clicks}</p>
                  </div>
                  <div className="stat">
                    <p className="label">{t('ctr')}</p>
                    <p className="value">{ctr === null ? '—' : `${ctr.toFixed(1)}%`}</p>
                  </div>
                </div>
                <div className="row wrap" style={{ marginTop: 14 }}>
                  <Button variant="outline" onClick={() => onToggle(c)} disabled={c.status === 'ended' || (c.status === 'paused' && !resumable)}>
                    {c.status === 'active' ? t('pause') : t('resume')}
                  </Button>
                  <Button variant="outline" onClick={() => onFund(c)} disabled={c.status === 'ended' || walletCents < 100}>
                    <Wallet width={15} height={15} aria-hidden />
                    {t('addFundsBtn')}
                  </Button>
                  <Button variant="outline" onClick={() => onEdit(c)} disabled={c.status === 'ended'}>
                    <PencilLine width={15} height={15} aria-hidden />
                    {t('editBtn')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="card" style={{ marginTop: 22 }}>
        <h3>{t('howTitle')}</h3>
        <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
          {t('howText')}
        </p>
      </div>
    </div>
  )
}
