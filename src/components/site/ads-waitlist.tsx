'use client'

import { useState } from 'react'
import { Megaphone, CheckCircle2, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api-client'

const FEATURES = [
  {
    title: 'Search ads on real queries',
    text: 'Text ads matched to exact and phrase keywords across Merklane search — never disguised as editorial results.',
  },
  {
    title: 'Banner placements that fit',
    text: 'Adaptive banners in agreed positions on desktop and mobile, with no empty blocks when nothing is sold.',
  },
  {
    title: 'Transparent auction',
    text: 'Higher eligible bids win priority; budget and balance caps keep spend under control — no black boxes.',
  },
  {
    title: 'Reporting you can audit',
    text: 'Impressions, clicks, confirmed transitions and spend in one ledger, exportable for your records.',
  },
]

export function AdsWaitlist() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<'joined' | 'already' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const result = await api<{ joined: boolean; alreadyOnList: boolean }>('/api/waitlist', {
        method: 'POST',
        body: { email, source: 'ads' },
      })
      setDone(result.alreadyOnList ? 'already' : 'joined')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join the waitlist')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container page">
      <section className="hero" style={{ textAlign: 'center' }}>
        <span className="eyebrow" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Megaphone width={14} height={14} aria-hidden /> MERKLANE ADS
        </span>
        <h1 style={{ fontSize: 'clamp(2.35rem, 5vw, 3.15rem)', marginTop: 13 }}>
          Advertising that respects the reader.
        </h1>
        <p className="hero-sub muted" style={{ maxWidth: 640, marginInline: 'auto' }}>
          Search and banner campaigns with a transparent auction, explicit budgets and reporting
          you can audit. Launching soon — join the waitlist and be first in line.
        </p>

        {done ? (
          <div className="card" style={{ maxWidth: 520, margin: '28px auto 0', padding: 26 }}>
            <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
              <CheckCircle2 width={22} height={22} style={{ color: 'var(--positive)' }} />
              <strong>
                {done === 'already' ? 'You are already on the list' : 'You are on the list'}
              </strong>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              We will email <strong>{email}</strong> the moment the advertising cabinet opens. A
              confirmation is on its way — nothing is charged, ever, for joining.
            </p>
          </div>
        ) : (
          <form className="search-box" style={{ marginInline: 'auto' }} onSubmit={submit} role="search">
            <Mail className="muted" width={22} height={22} aria-hidden />
            <input
              type="email"
              required
              aria-label="Email address"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ background: 'transparent', border: 0, outline: 'none', flex: 1, minWidth: 0, height: 40, fontSize: '1rem', color: 'inherit' }}
            />
            <Button
              type="submit"
              disabled={busy}
              style={{ background: 'var(--link)', color: '#081219', borderColor: 'var(--link)' }}
            >
              {busy ? 'Joining…' : 'Join waitlist'}
            </Button>
          </form>
        )}
        {error ? (
          <p className="field-error" style={{ marginTop: 10 }}>
            {error}
          </p>
        ) : null}

        <div className="quick-links" style={{ justifyContent: 'center' }}>
          <span className="chip">No credit card</span>
          <span className="chip">Launch email first</span>
          <span className="chip">Cancel anytime</span>
        </div>
      </section>

      <section className="section-block">
        <div className="section-title">
          <div className="row">
            <span className="section-icon">
              <Megaphone width={19} height={19} />
            </span>
            <div>
              <h2>What is coming</h2>
              <p>Everything below is in active development for the stage-3 launch.</p>
            </div>
          </div>
        </div>
        <div className="grid-2">
          {FEATURES.map((f) => (
            <div className="card" key={f.title}>
              <h3>{f.title}</h3>
              <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
                {f.text}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="notice" style={{ marginBottom: 0 }}>
          <Megaphone width={18} height={18} aria-hidden />
          <span>
            Every Merklane Ads placement will carry a clear <strong>Ads</strong> label, and organic
            results keep their time-based order. Where no suitable campaign exists, you see
            organic material only — never invented promotions.
          </span>
        </div>
      </section>
    </div>
  )
}
