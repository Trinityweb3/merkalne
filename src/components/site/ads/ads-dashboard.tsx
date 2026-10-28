'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, Wallet, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api-client'

/**
 * Advertiser dashboard: create campaigns, watch the weighted auction spend
 * live (balance, impressions, clicks, CTR), pause/resume, and top up the
 * balance with crypto. Top-ups run through the BlockBee processor when
 * configured (coin picker → hosted deposit address → on-chain confirmation
 * via the IPN webhook, status polled live); the manual/simulate fallback
 * keeps the old derived-address flow for testing.
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
}

interface TopUpInfo {
  id: string
  status: 'pending' | 'confirmed' | 'expired' | string
  walletAddress: string
  amountExpectedCents: number
  amountReceivedCents: number
  campaignId: string | null
  mode: 'manual' | 'simulate' | 'blockbee' | string
  provider?: 'blockbee' | 'manual' | string
  coin?: string | null
}

const BID_CHOICES = [1, 2, 3, 5, 10] // US cents per view

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

export function AdsDashboard() {
  const t = useTranslations('ads')
  const tc = useTranslations('common')

  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Top-up configuration advertised by GET /api/ads/campaigns (mode + coins)
  const [topUpCfg, setTopUpCfg] = useState<{ mode: string; coins: string[]; minCents: number; maxCents: number } | null>(null)

  // Create form
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [ctaUrl, setCtaUrl] = useState('')
  const [bid, setBid] = useState(2)
  const [creating, setCreating] = useState(false)

  // Top-up modal state
  const [topUpFor, setTopUpFor] = useState<Campaign | null>(null)
  const [amount, setAmount] = useState('10')
  const [coin, setCoin] = useState('')
  const [topUp, setTopUp] = useState<TopUpInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ campaigns: Campaign[]; topUp?: { mode: string; coins: string[]; minCents: number; maxCents: number } }>('/api/ads/campaigns')
      setCampaigns(data.campaigns)
      if (data.topUp) {
        setTopUpCfg(data.topUp)
        // Preselect the first offered coin (stablecoin-first ordering).
        setCoin((prev) => (prev && data.topUp?.coins.includes(prev) ? prev : (data.topUp?.coins[0] ?? prev)))
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setLoaded(true)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll the active top-up until it is confirmed.
  useEffect(() => {
    if (!topUp || topUp.status !== 'pending') return
    pollRef.current = setInterval(async () => {
      try {
        const data = await api<TopUpInfo>(`/api/ads/topups/${topUp.id}`)
        setTopUp(data)
        if (data.status === 'confirmed') {
          void refresh()
          void api('/api/ads/campaigns') // warm the next refresh
        }
      } catch {
        // polling errors are non-fatal; the next tick retries
      }
    }, 4000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [topUp, refresh])

  function closeModal() {
    if (pollRef.current) clearInterval(pollRef.current)
    setTopUpFor(null)
    setTopUp(null)
    setCopied(false)
  }

  async function createCampaign(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setCreating(true)
    try {
      await api('/api/ads/campaigns', {
        method: 'POST',
        body: { title, body, ctaUrl, bidPerView: bid },
      })
      setTitle('')
      setBody('')
      setCtaUrl('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setCreating(false)
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

  async function startTopUp(e: React.FormEvent) {
    e.preventDefault()
    if (!topUpFor) return
    setError(null)
    setBusy(true)
    try {
      const cents = Math.round(Number.parseFloat(amount) * 100)
      const isBlockbee = topUpCfg?.mode === 'blockbee'
      const data = await api<TopUpInfo>('/api/ads/topups', {
        method: 'POST',
        body: {
          campaignId: topUpFor.id,
          amountCents: cents,
          ...(isBlockbee ? { coin } : {}),
        },
      })
      setTopUp(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  async function simulatePayment() {
    if (!topUp) return
    setError(null)
    try {
      await api(`/api/ads/topups/${topUp.id}/simulate`, { method: 'POST' })
      const data = await api<TopUpInfo>(`/api/ads/topups/${topUp.id}`)
      setTopUp(data)
      if (data.status === 'confirmed') void refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    }
  }

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      {/* Campaigns                                                        */}
      {/* ---------------------------------------------------------------- */}
      <section className="section-block">
        <div className="section-title">
          <div className="row between" style={{ width: '100%' }}>
            <h2>{t('yourCampaigns')}</h2>
            <p className="muted small">
              {campaigns.length > 0
                ? t('campaignCount', { count: campaigns.length })
                : null}
            </p>
          </div>
        </div>

        {error ? (
          <p className="negative small" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </p>
        ) : null}

        {!loaded ? (
          <p className="muted small">{tc('loading')}</p>
        ) : campaigns.length === 0 ? (
          <div className="empty-state card" style={{ textAlign: 'center' }}>
            <h3>{t('noCampaigns')}</h3>
            <p className="muted small" style={{ marginTop: 8 }}>
              {t('noCampaignsText')}
            </p>
          </div>
        ) : (
          <div className="ads-campaign-list">
            {campaigns.map((c) => {
              const ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : null
              const resumable = c.status === 'paused' && c.balance >= c.bidPerView
              return (
                <div className="card ads-campaign" key={c.id}>
                  <div className="row between wrap" style={{ gap: 10 }}>
                    <strong className="ads-campaign-title">{c.title}</strong>
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
                  <p className="tiny muted" style={{ marginTop: 4 }}>
                    {hostOf(c.ctaUrl)} · {t('bidPerViewLabel', { cents: c.bidPerView })}
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
                    <Button variant="outline" onClick={() => toggleCampaign(c)} disabled={c.status === 'ended' || (c.status === 'paused' && !resumable)}>
                      {c.status === 'active' ? t('pause') : t('resume')}
                    </Button>
                    <Button
                      onClick={() => {
                        setTopUpFor(c)
                        setTopUp(null)
                      }}
                    >
                      <Wallet width={15} height={15} aria-hidden />
                      {t('topUp')}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Create form                                                      */}
      {/* ---------------------------------------------------------------- */}
      <section className="section-block">
        <div className="section-title">
          <h2>{t('createTitle')}</h2>
          <p className="muted small">{t('createSub')}</p>
        </div>
        <form className="card ads-create" onSubmit={createCampaign}>
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor="ad-title">
                {t('fieldTitle')}
              </label>
              <Input
                id="ad-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
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
                value={ctaUrl}
                onChange={(e) => setCtaUrl(e.target.value)}
                placeholder="https://"
                required
              />
            </div>
            <div className="field span-2">
              <label className="field-label" htmlFor="ad-body">
                {t('fieldBody')}
              </label>
              <textarea
                id="ad-body"
                className="ads-textarea"
                value={body}
                onChange={(e) => setBody(e.target.value)}
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
                    className={`chip ${bid === cents ? 'selected' : ''}`}
                    aria-pressed={bid === cents}
                    onClick={() => setBid(cents)}
                  >
                    {t('bidChip', { cents })}
                  </button>
                ))}
              </div>
              <small className="muted">{t('bidHint')}</small>
            </div>
          </div>
          <div className="button-row" style={{ marginTop: 18 }}>
            <Button type="submit" disabled={creating}>
              <Plus width={15} height={15} aria-hidden />
              {creating ? tc('loading') : t('createBtn')}
            </Button>
          </div>
        </form>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Top-up modal                                                     */}
      {/* ---------------------------------------------------------------- */}
      {topUpFor ? (
        <div
          className="ads-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t('topUpTitle')}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal()
          }}
        >
          <div className="card ads-modal">
            <div className="row between">
              <h3>{t('topUpTitle')}</h3>
              <button
                type="button"
                className="icon-button"
                aria-label={tc('cancel')}
                onClick={closeModal}
              >
                <X width={16} height={16} aria-hidden />
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 4 }}>
              {topUpFor.title} · {t('balance')} {money(topUpFor.balance)}
            </p>

            {!topUp ? (
              <form onSubmit={startTopUp} style={{ marginTop: 16 }}>
                {topUpCfg?.mode === 'blockbee' && topUpCfg.coins.length > 0 ? (
                  <div className="field" style={{ marginBottom: 14 }}>
                    <label className="field-label">{t('topUpCoin')}</label>
                    <div className="row wrap" style={{ gap: 8 }}>
                      {topUpCfg.coins.map((c) => (
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
                  <Button type="submit" disabled={busy || (topUpCfg?.mode === 'blockbee' && !coin)}>
                    {busy ? tc('loading') : t('topUpCreate')}
                  </Button>
                </div>
              </form>
            ) : (
              <div style={{ marginTop: 16 }}>
                <div className="ads-deposit">
                  <p className="tiny muted">
                    {topUp.provider === 'blockbee' && topUp.coin
                      ? `${t('topUpAddress')} — ${coinLabel(topUp.coin)}`
                      : t('topUpAddress')}
                  </p>
                  <code className="ads-address">{topUp.walletAddress}</code>
                  <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(topUp.walletAddress).then(() => {
                          setCopied(true)
                          setTimeout(() => setCopied(false), 2000)
                        })
                      }}
                    >
                      {copied ? tc('copied') : t('copyAddress')}
                    </Button>
                    {topUp.mode === 'simulate' && topUp.status === 'pending' ? (
                      <Button type="button" onClick={simulatePayment}>
                        {t('topUpSimulate')}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="muted small" style={{ marginTop: 12 }}>
                  {t('topUpExpected')} <strong>{money(topUp.amountExpectedCents)}</strong>
                  {topUp.provider === 'blockbee' && topUp.coin ? ` · ${coinLabel(topUp.coin)}` : ''}
                </p>
                <p
                  className={`small ${topUp.status === 'confirmed' ? 'positive' : 'muted'}`}
                  role="status"
                  style={{ marginTop: 8 }}
                >
                  {topUp.status === 'confirmed'
                    ? t('topUpConfirmed')
                    : topUp.provider === 'blockbee'
                      ? t('topUpBlockbeeNote')
                      : topUp.mode === 'simulate'
                        ? t('topUpSimulateNote')
                        : t('topUpManualNote')}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}
