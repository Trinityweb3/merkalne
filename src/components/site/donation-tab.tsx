'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Copy, Heart, Info, LifeBuoy } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'

interface DonationWallet {
  id: string
  network: string
  currency: string
  address: string
}

/** 0xB8f2…3f4A — middle truncation keeps head + tail identifiable. */
function shorten(address: string): string {
  if (address.length <= 14) return address
  return `${address.slice(0, 8)}…${address.slice(-6)}`
}

/**
 * Compact support tab pinned to the right edge, next to the menu — opens a
 * side sheet on desktop and a bottom sheet on mobile (CSS handles it).
 * Wallets come from GET /api/donations (environment-configured: SOL, BTC,
 * USDT on EVM). Donations are separate from Premium; when nothing is
 * configured the sheet says so honestly.
 */
export function DonationTab() {
  const t = useTranslations('donation')
  const [wallets, setWallets] = useState<DonationWallet[]>([])
  const [loaded, setLoaded] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/donations')
      .then((r) => (r.ok ? r.json() : { wallets: [] }))
      .then((data: { wallets?: DonationWallet[] }) => {
        if (!cancelled) setWallets(Array.isArray(data.wallets) ? data.wallets : [])
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function copyAddress(wallet: DonationWallet) {
    // Modern async clipboard first; fall back to the select+execCommand path
    // for non-secure contexts or headless/locked-down environments.
    let ok = false
    try {
      await navigator.clipboard.writeText(wallet.address)
      ok = true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = wallet.address
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        ta.remove()
      } catch {
        ok = false
      }
    }
    if (ok) {
      setCopiedId(wallet.id)
      setTimeout(() => setCopiedId((id) => (id === wallet.id ? null : id)), 2000)
    }
    // When neither path works, the full address below stays selectable —
    // nothing fails loudly for the donor.
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button className="donation-tab" aria-label={t('title')} title={t('title')}>
          <Heart />
          <span>{t('support')}</span>
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="donation-sheet p-0">
        <SheetHeader className="donation-heading">
          <div className="row" style={{ gap: 14 }}>
            <span className="donation-heart">
              <Heart width={24} height={24} />
            </span>
            <div>
              <SheetTitle className="donation-title">{t('title')}</SheetTitle>
              <SheetDescription className="donation-intro">{t('intro')}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="donation-body">
          <div className="donation-wallet">
            <h3 style={{ fontSize: '1rem' }}>{t('wallet')}</h3>

            {!loaded ? (
              <p className="muted small">{t('wallet')}</p>
            ) : wallets.length === 0 ? (
              <p className="muted small">{t('notConfigured')}</p>
            ) : (
              <ul style={{ display: 'grid', gap: 14, listStyle: 'none', padding: 0, margin: 0 }}>
                {wallets.map((wallet) => (
                  <li
                    key={wallet.id}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '12px 14px',
                      background: 'var(--muted)',
                    }}
                  >
                    <div className="row between" style={{ gap: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{wallet.network}</div>
                        <div className="muted small">
                          {t('currency')}: <b style={{ color: 'var(--foreground)' }}>{wallet.currency}</b>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyAddress(wallet)}
                        aria-label={`${t('copy')} (${wallet.currency})`}
                      >
                        {copiedId === wallet.id ? <Check /> : <Copy />}
                        {copiedId === wallet.id ? t('copied') : t('copy')}
                      </Button>
                    </div>
                    {/* Full address on its own line, selectable when the
                        clipboard is blocked; word-break keeps it inside. */}
                    <code
                      className="small"
                      style={{
                        display: 'block',
                        marginTop: 10,
                        wordBreak: 'break-all',
                        color: 'var(--link)',
                        userSelect: 'all',
                      }}
                    >
                      {wallet.address}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="donation-dream">
            <h3 className="row" style={{ gap: 8 }}>
              <LifeBuoy width={17} height={17} style={{ color: 'var(--link)' }} />
              {t('whereSupport')}
            </h3>
            <p className="muted small">{t('whereSupportText')}</p>
          </div>

          <div className="donation-settings-row">
            <h3 className="row" style={{ gap: 8, fontSize: '1rem' }}>
              <Info width={17} height={17} style={{ color: 'var(--link)' }} />
              {t('goodToKnow')}
            </h3>
            <ul className="muted small" style={{ display: 'grid', gap: 8 }}>
              <li>• {t('know1')}</li>
              <li>• {t('know2')}</li>
              <li>• {t('know3')}</li>
            </ul>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
