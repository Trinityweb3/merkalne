'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { BadgeCheck, Check, Copy, ShieldCheck, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api-client'
import { useSession, sessionPremiumActive } from '@/components/providers/session-provider'
import { PLAN_PRICING, formatUsd, type BillingPeriod, type PremiumPlan } from '@/lib/premium/plan'

/**
 * The /premium pricing page — fully i18n'd, legacy-template vocabulary
 * (pricing-hero, pricing-grid, card price-card, chip, badge, button-row).
 *
 * Billing flow (stage-2 launch — real money):
 *   1. Monthly / Yearly toggle (yearly = save 50%)
 *   2. "Get Premium" / "Get Premium+" opens the BlockBee checkout modal:
 *      pick a coin → the server mints a PremiumOrder (prem_/premplus_
 *      order-id) and returns a hosted payment address → the user sends the
 *      exact amount → the modal polls the order until the IPN webhook
 *      confirms it on-chain → the plan activates.
 *   Prices always come from PLAN_PRICING (server-side catalog) — the client
 *   never sends an amount.
 */

interface CheckoutOrder {
  id: string
  plan: PremiumPlan
  period: BillingPeriod
  walletAddress: string
  amountExpectedCents: number
  status: 'pending' | 'confirmed' | 'expired' | string
  provider: string
  coin: string
}

interface Props {
  /** BlockBee configured on this deployment (BLOCKBEE_API_KEY present) */
  configured: boolean
  /** Allowed coin tickers (stablecoins + majors on cheap networks, no TRON) */
  coins: string[]
}

function coinLabel(coin: string): string {
  const [network, token] = coin.includes('_') ? coin.split('_') : [null, coin]
  if (!network) return coin.toUpperCase()
  const net =
    network === 'polygon'
      ? 'Polygon'
      : network === 'bep20'
        ? 'BSC'
        : network === 'arbitrum'
          ? 'Arbitrum'
          : network.toUpperCase()
  return `${token.toUpperCase()} · ${net}`
}

export function PricingPlans({ configured, coins }: Props) {
  const t = useTranslations('premium')
  const tc = useTranslations('common')
  const th = useTranslations('header')
  const locale = useLocale()
  const { user, refresh } = useSession()

  const [billing, setBilling] = useState<BillingPeriod>('monthly')
  const [checkoutFor, setCheckoutFor] = useState<PremiumPlan | null>(null)
  const [coin, setCoin] = useState(coins[0] ?? '')
  const [order, setOrder] = useState<CheckoutOrder | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const premiumActive = sessionPremiumActive(user)
  const premiumPlusActive = premiumActive && user?.plan === 'premium_plus'
  const activeUntil = user?.premiumUntil ? new Date(user.premiumUntil) : null

  // Poll the order while the payment is pending; refresh the session chrome
  // the moment the webhook confirms so the header badge flips live.
  useEffect(() => {
    if (!order || order.status !== 'pending') return
    pollRef.current = setInterval(async () => {
      try {
        const data = await api<CheckoutOrder>(`/api/premium/checkout/${order.id}`)
        setOrder((prev) => (prev && prev.id === data.id ? data : prev))
        if (data.status === 'confirmed') void refresh()
      } catch {
        // polling errors are non-fatal; the next tick retries
      }
    }, 4000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [order, refresh])

  function closeCheckout() {
    if (pollRef.current) clearInterval(pollRef.current)
    setCheckoutFor(null)
    setOrder(null)
    setCopied(false)
    setError(null)
  }

  async function startCheckout(e: React.FormEvent) {
    e.preventDefault()
    if (!checkoutFor) return
    setError(null)
    setBusy(true)
    try {
      const data = await api<CheckoutOrder>('/api/premium/checkout', {
        method: 'POST',
        body: { plan: checkoutFor, period: billing, coin },
      })
      setOrder(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  function beginCheckout(plan: PremiumPlan) {
    if (!user) {
      // Send the visitor through register and straight back here.
      window.location.href = `/${locale !== 'en' ? `${locale}/` : ''}auth?mode=register&next=${encodeURIComponent('/premium')}`
      return
    }
    setCheckoutFor(plan)
    setOrder(null)
    setError(null)
    setCopied(false)
    setCoin((prev) => (prev && coins.includes(prev) ? prev : (coins[0] ?? prev)))
  }

  const planCards: {
    key: 'free' | 'premium' | 'premium_plus'
    name: string
    tagline: string
    features: string[]
    price: string
    per: string
    featured?: boolean
    cta: () => React.ReactNode
  }[] = [
    {
      key: 'free',
      name: t('planFree'),
      tagline: t('taglineFree'),
      features: [t('freeF1'), t('freeF2'), t('freeF3'), t('freeF4'), t('freeF5')],
      price: '$0',
      per: '',
      cta: () => (
        <Link href={user ? '/profile' : '/auth?mode=register'}>
          <Button variant="outline" className="full-width">
            {user ? t('ctaCurrent') : t('createAccount')}
          </Button>
        </Link>
      ),
    },
    {
      key: 'premium',
      name: t('planPremium'),
      tagline: t('taglinePremium'),
      features: [t('premF1'), t('premF2'), t('premF3'), t('premF4')],
      price: formatUsd(billing === 'monthly' ? PLAN_PRICING.premium.monthlyCents : PLAN_PRICING.premium.yearlyCents),
      per: `/${billing === 'monthly' ? t('perMonth') : t('perYear')}`,
      featured: true,
      cta: () =>
        !user || !premiumActive ? (
          <Button
            className="full-width"
            style={{ background: 'var(--link)', color: '#081219' }}
            onClick={() => beginCheckout('premium')}
          >
            <Sparkles width={15} height={15} /> {premiumActive ? t('ctaUpgrade') : t('ctaGetPremium')}
          </Button>
        ) : (
          <Button variant="outline" className="full-width" onClick={() => beginCheckout('premium')}>
            <BadgeCheck width={15} height={15} /> {t('ctaExtend')}
          </Button>
        ),
    },
    {
      key: 'premium_plus',
      name: t('planPremiumPlus'),
      tagline: t('taglinePlus'),
      features: [t('plusF1'), t('plusF2'), t('plusF3'), t('plusF4')],
      price: formatUsd(billing === 'monthly' ? PLAN_PRICING.premium_plus.monthlyCents : PLAN_PRICING.premium_plus.yearlyCents),
      per: `/${billing === 'monthly' ? t('perMonth') : t('perYear')}`,
      cta: () =>
        !user || !premiumPlusActive ? (
          <Button
            className="full-width"
            style={{ background: 'var(--link)', color: '#081219' }}
            onClick={() => beginCheckout('premium_plus')}
          >
            <Sparkles width={15} height={15} /> {premiumActive ? t('ctaUpgrade') : t('ctaGetPlus')}
          </Button>
        ) : (
          <Button variant="outline" className="full-width" onClick={() => beginCheckout('premium_plus')}>
            <BadgeCheck width={15} height={15} /> {t('ctaExtend')}
          </Button>
        ),
    },
  ]

  return (
    <div className="container page">
      <section className="pricing-hero">
        <span className="eyebrow">{t('heroEyebrow')}</span>
        <h1>{t('heroTitle')}</h1>
        <p>{t('heroSub')}</p>

        <div className="button-row" style={{ justifyContent: 'center', marginTop: 26 }}>
          <div className="row" style={{ gap: 6, background: 'var(--muted)', padding: 4, borderRadius: 9 }}>
            <button
              type="button"
              className={`chip ${billing === 'monthly' ? 'selected' : ''}`}
              style={{ border: 0 }}
              onClick={() => setBilling('monthly')}
            >
              {t('monthly')}
            </button>
            <button
              type="button"
              className={`chip ${billing === 'yearly' ? 'selected' : ''}`}
              style={{ border: 0 }}
              onClick={() => setBilling('yearly')}
            >
              {t('yearly')} · {t('save50')}
            </button>
          </div>
        </div>
      </section>

      {/* Current-subscription banner */}
      {user && premiumActive ? (
        <section className="section-block" style={{ maxWidth: 780, marginInline: 'auto' }}>
          <div className="card" style={{ padding: 20 }}>
            <div className="row between wrap" style={{ gap: 12 }}>
              <div className="row" style={{ gap: 10, minWidth: 0 }}>
                <BadgeCheck width={20} height={20} style={{ color: 'var(--positive)' }} aria-hidden />
                <div>
                  <strong>
                    {premiumPlusActive ? t('statusActivePlus') : t('statusActive')}
                  </strong>
                  <p className="muted small" style={{ marginTop: 2 }}>
                    {activeUntil ? t('statusUntil', { date: activeUntil.toLocaleDateString(locale) }) : t('statusNeverExpires')}
                  </p>
                </div>
              </div>
              <Link href="/alerts" className="link" style={{ whiteSpace: 'nowrap' }}>
                {t('manageAlerts')} →
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      <div className="pricing-grid">
        {planCards.map((plan) => (
          <div className={`card price-card ${plan.featured ? 'featured' : ''}`} key={plan.key}>
            <div className="row between">
              <h2>{plan.name}</h2>
              {plan.featured ? <span className="badge state-published">{t('badgePopular')}</span> : null}
            </div>
            <p className="muted small" style={{ marginTop: 6 }}>
              {plan.tagline}
            </p>
            <div className="price">
              {plan.price}
              <span> {plan.per}</span>
            </div>
            <ul className="price-features">
              {plan.features.map((feature) => (
                <li key={feature}>
                  <Check width={17} height={17} aria-hidden /> <span>{feature}</span>
                </li>
              ))}
            </ul>
            {plan.cta()}
          </div>
        ))}
      </div>

      <p className="muted small" style={{ textAlign: 'center', marginTop: 18 }}>
        {t('blockbeeNote')}
      </p>

      <section className="faq">
        <h2 style={{ textAlign: 'center', marginBottom: 10 }}>{t('faqTitle')}</h2>
        {[1, 2, 3, 4].map((i) => (
          <details key={i}>
            <summary>{t(`faqQ${i}`)}</summary>
            <p>{t(`faqA${i}`)}</p>
          </details>
        ))}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Checkout modal (BlockBee)                                        */}
      {/* ---------------------------------------------------------------- */}
      {checkoutFor ? (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-5 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('checkoutTitle', { plan: checkoutFor === 'premium' ? t('planPremium') : t('planPremiumPlus') })}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeCheckout()
          }}
        >
          <div className="card w-full max-w-[480px] shadow-2xl">
            <div className="row between">
              <h3>
                {t('checkoutTitle', { plan: checkoutFor === 'premium' ? t('planPremium') : t('planPremiumPlus') })}
              </h3>
              <button type="button" className="icon-button" aria-label={tc('cancel')} onClick={closeCheckout}>
                <X width={16} height={16} aria-hidden />
              </button>
            </div>

            {!configured ? (
              <div style={{ marginTop: 16 }}>
                <p className="muted small">{t('checkoutUnavailable')}</p>
              </div>
            ) : !order ? (
              <form onSubmit={startCheckout} style={{ marginTop: 16 }}>
                <p className="muted small" style={{ marginBottom: 14 }}>
                  {t('checkoutSummary', {
                    plan: checkoutFor === 'premium' ? t('planPremium') : t('planPremiumPlus'),
                    price: formatUsd(
                      billing === 'monthly'
                        ? PLAN_PRICING[checkoutFor].monthlyCents
                        : PLAN_PRICING[checkoutFor].yearlyCents,
                    ),
                    period: billing === 'monthly' ? t('perMonth') : t('perYear'),
                  })}
                </p>
                <div className="field" style={{ marginBottom: 14 }}>
                  <label className="field-label">{t('checkoutCoin')}</label>
                  <div className="row wrap" style={{ gap: 8 }}>
                    {coins.map((c) => (
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
                  <small className="muted">{t('checkoutCoinNote')}</small>
                </div>
                <div className="button-row" style={{ marginTop: 14 }}>
                  <Button type="submit" disabled={busy || !coin}>
                    {busy ? tc('loading') : t('checkoutPay')}
                  </Button>
                </div>
              </form>
            ) : order.status === 'confirmed' ? (
              <div style={{ marginTop: 16 }}>
                <div className="row" style={{ gap: 10 }}>
                  <BadgeCheck width={20} height={20} style={{ color: 'var(--positive)' }} aria-hidden />
                  <p style={{ margin: 0 }}>
                    {t('checkoutConfirmed', { plan: order.plan === 'premium' ? t('planPremium') : t('planPremiumPlus') })}
                  </p>
                </div>
                <p className="muted small" style={{ marginTop: 8 }}>
                  {t('checkoutConfirmedNote')}
                </p>
                <div className="button-row" style={{ marginTop: 14 }}>
                  <Button onClick={closeCheckout}>{tc('cancel')}</Button>
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 16 }}>
                <div className="rounded-lg border border-dashed border-chart-4/40 p-3.5">
                  <p className="tiny muted">
                    {t('checkoutAddress')} — {coinLabel(order.coin || coin)}
                  </p>
                  <code className="mt-2 block break-all rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
                    {order.walletAddress}
                  </code>
                  <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(order.walletAddress).then(() => {
                          setCopied(true)
                          setTimeout(() => setCopied(false), 2000)
                        })
                      }}
                    >
                      {copied ? <Check width={14} height={14} /> : <Copy width={14} height={14} />}{' '}
                      {copied ? tc('copied') : t('checkoutCopy')}
                    </Button>
                  </div>
                </div>
                <p className="muted small" style={{ marginTop: 12 }}>
                  {t('checkoutAmount')} <strong>{formatUsd(order.amountExpectedCents)}</strong>
                  {order.coin ? ` · ${coinLabel(order.coin)}` : ''}
                </p>
                <p className="small muted" role="status" style={{ marginTop: 8 }}>
                  {t('checkoutPending')}
                </p>
                <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
                  <ShieldCheck width={15} height={15} aria-hidden />
                  <span className="tiny muted">{t('checkoutSecurity')}</span>
                </div>
              </div>
            )}

            {error ? (
              <p className="field-error" style={{ marginTop: 10 }}>
                {error}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
