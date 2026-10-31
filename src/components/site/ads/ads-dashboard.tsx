'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Megaphone, PencilLine, Plus, Send, Target, Trash2, Wallet, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api-client'
import { LANGUAGES, POST_SECTIONS, SECTION_META } from '@/lib/constants'
import {
  type AdFormat,
  type BillingModel,
  centsToMicro,
  formatMicroUsd,
} from '@/lib/ads/money'
import {
  CampaignWizard,
  type WizardCampaign,
} from '@/components/site/ads/campaign-wizard'

/**
 * Advertiser dashboard — the "Merklane ADS" tab of the profile cabinet.
 *
 * Two sub-sections (money and campaigns are never mixed):
 *   Wallet    deposit with crypto (BlockBee) into the unified wallet, watch
 *             the available/reserved split, the deposit history and the
 *             immutable ledger (credit / reserve / charge / refund).
 *   Campaigns the campaign list + "Create campaign". FORMAT (text/banner)
 *             and BILLING MODEL (CPC/CPM) are chosen INDEPENDENTLY; the bid
 *             is always shown in its model's unit ("$0.50 per click" /
 *             "$2.00 per 1000 views"). Every campaign's budget is reserved
 *             from the wallet at creation / "add funds" time.
 *
 * Flow: fund the wallet first, then create campaigns. A fresh advertiser
 * (no campaigns yet) lands on the Wallet tab; once campaigns exist the
 * Campaigns tab opens first.
 *
 * Styling deliberately sticks to the legacy template vocabulary (card,
 * stat-grid, chip, badge, field, table-wrap) plus standard Tailwind
 * utilities, so it stays native to the restored original design.
 *
 * Phase 2: campaign creation/editing happens in the 5-step
 * <CampaignWizard/> (Name & Format → Creative → Targeting → Bidding &
 * Budget → Summary & Submit); this dashboard keeps the wallet, the
 * campaign list, add-funds and delete. DRAFT and REJECTED campaigns are
 * listed with their moderation status (and the rejection reason) and can
 * be re-opened in the wizard or submitted for review directly.
 */

interface Campaign {
  id: string
  name: string
  format: 'text' | 'banner'
  billingModel: 'cpc' | 'cpm'
  bidMicroUsd: number
  dailyBudgetMicroUsd: number
  totalBudgetMicroUsd: number
  status: 'active' | 'paused' | 'completed' | 'draft' | 'pending' | 'rejected' | string
  deletedAt: string | null
  createdAt: string
  targetSections: string[]
  targetLocales: string[]
  targetKeywords: string[]
  keywordMatch: string
  countryMode: string
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
  budget: {
    committedMicroUsd: number
    spentMicroUsd: number
    heldMicroUsd: number
    remainingMicroUsd: number
    spentTodayMicroUsd: number
  }
  stats: { served: number; views: number; clicks: number; held: number }
}

interface LedgerRow {
  id: string
  type: 'credit' | 'reserve' | 'charge' | 'refund' | string
  amountMicroUsd: number
  campaignId: string | null
  campaignName: string | null
  eventId: string
  createdAt: string
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
  availableMicroUsd: number
  reservedMicroUsd: number
  pendingCents: number
  ledger: LedgerRow[]
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

function money(micro: number): string {
  return formatMicroUsd(micro)
}

function centsMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/** "0.50" → 50 (cents). Returns NaN for garbage. */
function dollarsToCents(input: string): number {
  const value = Number.parseFloat(input)
  if (!Number.isFinite(value) || value < 0) return Number.NaN
  return Math.round(value * 100)
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

  // Campaign wizard (Phase 2) — replaces the old single-modal form.
  // create → the 5-step wizard from scratch; edit → re-open an existing
  // campaign (draft, rejected, pending, active or paused — anything that
  // is not completed/deleted).
  const [wizardOpen, setWizardOpen] = useState<null | { mode: 'create' } | { mode: 'edit'; campaign: Campaign }>(null)

  // Add funds (wallet → campaign budget)
  const [fundFor, setFundFor] = useState<Campaign | null>(null)
  const [fundAmount, setFundAmount] = useState('5')
  const [fundBusy, setFundBusy] = useState(false)
  const [fundError, setFundError] = useState<string | null>(null)

  // Delete confirmation
  const [deleteFor, setDeleteFor] = useState<Campaign | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

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
  async function submitCampaign(c: Campaign) {
    // Submit a draft/rejected campaign for review straight from the card
    // (the wizard Step 5 button does the same for edited campaigns).
    setError(null)
    try {
      await api(`/api/ads/campaigns/${c.id}`, {
        method: 'PATCH',
        body: { action: 'submit' },
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
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
    const cents = dollarsToCents(fundAmount)
    if (Number.isNaN(cents) || cents < 100) {
      setFundError(t('fundMinHint'))
      return
    }
    if (wallet && centsToMicro(cents) > wallet.availableMicroUsd) {
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

  async function confirmDelete() {
    if (!deleteFor) return
    setDeleteBusy(true)
    setError(null)
    try {
      await api(`/api/ads/campaigns/${deleteFor.id}`, {
        method: 'PATCH',
        body: { action: 'delete' },
      })
      setDeleteFor(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setDeleteBusy(false)
    }
  }

  // ------------------------------------------------------------------ render
  const availableMicro = wallet?.availableMicroUsd ?? 0

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
          availableMicro={availableMicro}
          onCreate={() => setWizardOpen({ mode: 'create' })}
          onEdit={(c) => setWizardOpen({ mode: 'edit', campaign: c })}
          onSubmit={submitCampaign}
          onFund={openFund}
          onToggle={toggleCampaign}
          onDelete={setDeleteFor}
        />
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Campaign wizard (Phase 2) — 5 steps: Name & Format → Creative →   */}
      {/* Targeting → Bidding & Budget → Summary & Submit. Drafts save at  */}
      {/* any step; submission goes to moderation, never straight live.     */}
      {/* ---------------------------------------------------------------- */}
      {wizardOpen ? (
        <CampaignWizard
          mode={wizardOpen.mode}
          campaign={wizardOpen.mode === 'edit' ? (wizardOpen.campaign as WizardCampaign) : undefined}
          availableMicro={availableMicro}
          onClose={() => setWizardOpen(null)}
          onSaved={refresh}
        />
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Deposit modal (BlockBee / manual) — credits the unified wallet    */}
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
              {t('walletBalanceLabel')}: <strong>{money(availableMicro)}</strong>
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
                  {t('topUpExpected')} <strong>{centsMoney(activeDeposit.amountExpectedCents)}</strong>
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
      {/* Add funds modal (wallet → campaign budget)                        */}
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
              {fundFor.name} · {t('remainingLabel')} {money(fundFor.budget.remainingMicroUsd)}
            </p>
            <p className="muted tiny" style={{ marginTop: 6 }}>
              {t('fundNote', { amount: money(availableMicro) })}
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
                  max={Math.max(availableMicro / 10_000, 1)}
                  step={0.5}
                  value={fundAmount}
                  onChange={(e) => setFundAmount(e.target.value)}
                  required
                />
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setFundAmount((availableMicro / 1_000_000).toFixed(2))}
                    disabled={availableMicro < 100 * 10_000}
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

      {/* ---------------------------------------------------------------- */}
      {/* Delete confirmation — refunds the unspent budget to the wallet    */}
      {/* ---------------------------------------------------------------- */}
      {deleteFor ? (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-5 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('deleteTitle')}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteFor(null)
          }}
        >
          <div className="card w-full max-w-[440px] shadow-2xl">
            <div className="row between">
              <h3>{t('deleteTitle')}</h3>
              <button type="button" className="icon-button" aria-label={tc('cancel')} onClick={() => setDeleteFor(null)}>
                <X width={16} height={16} aria-hidden />
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
              {deleteFor.name}
            </p>
            <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
              {t('deleteNote')}{' '}
              {t('remainingLabel')}: <strong>{money(deleteFor.budget.remainingMicroUsd)}</strong>
            </p>
            <div className="button-row" style={{ marginTop: 16 }}>
              <Button variant="outline" type="button" onClick={() => setDeleteFor(null)}>
                {tc('cancel')}
              </Button>
              <Button type="button" onClick={confirmDelete} disabled={deleteBusy}>
                <Trash2 width={15} height={15} aria-hidden />
                {deleteBusy ? tc('loading') : t('deleteBtn')}
              </Button>
            </div>
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

  const movementLabel = (type: string): string => {
    if (type === 'credit') return t('ledgerCredit')
    if (type === 'reserve') return t('ledgerReserve')
    if (type === 'charge') return t('ledgerCharge')
    if (type === 'refund') return t('ledgerRefund')
    return type
  }

  return (
    <div>
      <div className="stat-grid">
        <div className="stat">
          <p className="label">{t('walletBalanceLabel')}</p>
          <p className="value">{money(wallet?.availableMicroUsd ?? 0)}</p>
          <p className="detail">{t('walletHint')}</p>
        </div>
        <div className="stat">
          <p className="label">{t('inCampaignsLabel')}</p>
          <p className="value">{money(wallet?.reservedMicroUsd ?? 0)}</p>
          <p className="detail">{t('inCampaignsDetail')}</p>
        </div>
        <div className="stat">
          <p className="label">{t('pendingLabel')}</p>
          <p className="value">{centsMoney(wallet?.pendingCents ?? 0)}</p>
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

      {/* Immutable ledger — the double-entry trail */}
      <div className="section-block" style={{ marginTop: 18 }}>
        <div className="section-title">
          <h2>{t('ledgerTitle')}</h2>
        </div>
        {(wallet?.ledger.length ?? 0) === 0 ? (
          <div className="empty-state card" style={{ textAlign: 'center' }}>
            <h3>{t('ledgerEmpty')}</h3>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('colDate')}</th>
                  <th>{t('colMovement')}</th>
                  <th>{t('colCampaign')}</th>
                  <th>{t('colAmount')}</th>
                </tr>
              </thead>
              <tbody>
                {wallet?.ledger.map((row) => (
                  <tr key={row.id} className="data-row">
                    <td className="muted">{new Date(row.createdAt).toLocaleDateString()}</td>
                    <td>{movementLabel(row.type)}</td>
                    <td className="muted">{row.campaignName ?? '—'}</td>
                    <td className={row.amountMicroUsd < 0 ? 'negative' : 'positive'}>{money(row.amountMicroUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Deposit history (BlockBee intentions) */}
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
                        ? centsMoney(row.amountReceivedCents)
                        : centsMoney(row.amountExpectedCents)}
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
  availableMicro,
  onCreate,
  onEdit,
  onSubmit,
  onFund,
  onToggle,
  onDelete,
}: {
  campaigns: Campaign[]
  loaded: boolean
  availableMicro: number
  onCreate: () => void
  onEdit: (c: Campaign) => void
  /** Submit a draft/rejected campaign for review (PATCH action "submit"). */
  onSubmit: (c: Campaign) => void
  onFund: (c: Campaign) => void
  onToggle: (c: Campaign) => void
  onDelete: (c: Campaign) => void
}) {
  const t = useTranslations('ads')
  const tc = useTranslations('common')

  /** Status badge in the legacy vocabulary: active=green, review=amber
   *  text, draft=muted, rejected=negative. */
  function statusBadge(c: Campaign) {
    const cls =
      c.status === 'active'
        ? 'state-active'
        : c.status === 'pending'
          ? 'state-under-review'
          : c.status === 'rejected'
            ? 'negative'
            : 'state-draft' // draft / paused / completed
    const label =
      c.status === 'active'
        ? t('statusActive')
        : c.status === 'pending'
          ? t('statusPending')
          : c.status === 'rejected'
            ? t('statusRejected')
            : c.status === 'draft'
              ? t('statusDraft')
              : c.status === 'paused'
                ? t('statusPaused')
                : t('statusCompleted')
    return (
      <span className={`badge ${cls}`}>
        {label}
        {c.creative ? ` · v${c.creative.version}` : ''}
      </span>
    )
  }

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
            <Button onClick={onCreate} disabled={availableMicro < 100 * 10_000}>
              <Plus width={15} height={15} aria-hidden />
              {t('newCampaignBtn')}
            </Button>
          </div>
          {availableMicro < 100 * 10_000 ? (
            <p className="muted tiny" style={{ marginTop: 10 }}>
              {t('insufficientWallet')}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-4">
          {campaigns.map((c) => {
            const isCpc = c.billingModel === 'cpc'
            const ctr = isCpc && c.stats.served > 0 ? (c.stats.clicks / c.stats.served) * 100 : null
            // Resume only makes sense while the derived budget still covers
            // one billable event.
            const perEvent = isCpc ? c.bidMicroUsd : Math.floor(c.bidMicroUsd / 1000)
            const resumable = c.status === 'paused' && c.budget.remainingMicroUsd >= perEvent
            const completed = c.status === 'completed' || c.deletedAt !== null
            // Soft-deleted rows keep their original status label but are
            // read-only like completed ones.
            const editable = !completed
            const submittable = c.status === 'draft' || c.status === 'rejected'
            const targets = [
              c.targetSections.length > 0
                ? `${c.targetSections.length}/${SECTION_OPTIONS.length} ${t('targetSectionsLabel')}`
                : null,
              c.targetLocales.length > 0
                ? `${c.targetLocales.length}/${LOCALE_OPTIONS.length} ${t('targetLocalesLabel')}`
                : null,
              c.targetKeywords.length > 0
                ? `${c.targetKeywords.length} ${t('keywordsLabel')}`
                : null,
              c.targetHashtags.length > 0
                ? `${c.targetHashtags.length} ${t('hashtagsLabel')}`
                : null,
              c.countryMode !== 'all' && c.targetCountries.length > 0
                ? `${c.targetCountries.length} ${t('countriesLabel')}`
                : null,
            ].filter(Boolean)
            return (
              <div className="card ads-campaign" key={c.id}>
                <div className="row between wrap" style={{ gap: 10 }}>
                  <strong className="text-[1.05rem] tracking-tight">{c.name}</strong>
                  {statusBadge(c)}
                </div>
                <p className="muted small" style={{ marginTop: 6 }}>
                  {c.format === 'banner' && c.creative?.imageUrl ? (
                    <img
                      src={c.creative.imageUrl}
                      alt={c.creative.altText ?? c.name}
                      className="max-h-24 w-full rounded-md object-cover"
                      loading="lazy"
                    />
                  ) : (
                    (c.creative?.title ?? '—')
                  )}
                </p>
                {c.status === 'rejected' && c.creative?.moderationNote ? (
                  <p className="negative small" role="alert" style={{ marginTop: 6 }}>
                    {t('wizardRejectedNote', { reason: c.creative.moderationNote })}
                  </p>
                ) : null}
                {c.status === 'pending' ? (
                  <p className="muted tiny" style={{ marginTop: 6 }}>
                    {t('inReviewNote')}
                  </p>
                ) : null}
                <p className="tiny muted" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Target width={12} height={12} aria-hidden />
                  {c.format === 'text' ? t('formatText') : t('formatBanner')} · {isCpc ? t('badgeCpc') : t('badgeCpm')} ·{' '}
                  {t(c.billingModel === 'cpc' ? 'bidLineCpc' : 'bidLineCpm', {
                    amount: money(c.bidMicroUsd),
                  })}
                  {targets.length === 0 ? '' : ` · ${targets.join(' · ')}`} ·{' '}
                  {c.creative?.displayDomain || hostOf(c.creative?.targetUrl ?? '')}
                </p>
                <div className="stat-grid" style={{ marginTop: 14 }}>
                  <div className="stat">
                    <p className="label">{t('remainingLabel')}</p>
                    <p className="value">{money(c.budget.remainingMicroUsd)}</p>
                  </div>
                  <div className="stat">
                    <p className="label">{t('spentLabel')}</p>
                    <p className="value">{money(c.budget.spentMicroUsd)}</p>
                  </div>
                  <div className="stat">
                    <p className="label">{isCpc ? t('servedLabel') : t('viewsLabel')}</p>
                    <p className="value">{isCpc ? c.stats.served : c.stats.views}</p>
                  </div>
                  <div className="stat">
                    <p className="label">{isCpc ? t('clicks') : t('ctr')}</p>
                    <p className="value">
                      {isCpc ? c.stats.clicks : ctr === null ? '—' : `${ctr.toFixed(1)}%`}
                    </p>
                  </div>
                </div>
                {c.status === 'paused' && !resumable ? (
                  <p className="muted tiny" style={{ marginTop: 10 }}>
                    {t('outOfBudget')}
                  </p>
                ) : null}
                <div className="row wrap" style={{ marginTop: 14 }}>
                  {submittable ? (
                    <Button variant="outline" onClick={() => onSubmit(c)}>
                      <Send width={15} height={15} aria-hidden />
                      {t('submitReviewBtn')}
                    </Button>
                  ) : null}
                  {c.status === 'active' || c.status === 'paused' ? (
                    <Button
                      variant="outline"
                      onClick={() => onToggle(c)}
                      disabled={c.status === 'paused' && !resumable}
                    >
                      {c.status === 'active' ? t('pause') : t('resume')}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    onClick={() => onFund(c)}
                    disabled={completed || c.status === 'draft' || availableMicro < 100 * 10_000}
                  >
                    <Wallet width={15} height={15} aria-hidden />
                    {t('addFundsBtn')}
                  </Button>
                  {editable ? (
                    <Button variant="outline" onClick={() => onEdit(c)}>
                      <PencilLine width={15} height={15} aria-hidden />
                      {t('editBtn')}
                    </Button>
                  ) : null}
                  {!completed ? (
                    <Button variant="outline" onClick={() => onDelete(c)}>
                      <Trash2 width={15} height={15} aria-hidden />
                      {t('deleteBtn')}
                    </Button>
                  ) : null}
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
