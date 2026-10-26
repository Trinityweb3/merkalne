'use client'

import { useState } from 'react'
import { Link } from '@/i18n/navigation'
import { Check, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { api } from '@/lib/api-client'
import { useSession } from '@/components/providers/session-provider'

const PLANS = [
  {
    name: 'Free',
    monthly: 0,
    yearly: 0,
    tagline: 'Everything to explore and get hired.',
    features: [
      'Reading and search on all sections',
      'Profile and synced bookmarks',
      'Comments and reactions',
      'Free Blog publishing',
      'All 20 interface languages',
    ],
    cta: 'Your current plan',
  },
  {
    name: 'Premium',
    monthly: 5,
    yearly: 30,
    featured: true,
    tagline: 'Delivery and filters for serious hunters.',
    features: [
      'Everything in Free',
      'Personal Telegram bot',
      'Unlimited filter rules',
      'Digest before everyone else',
    ],
    cta: 'Get Premium',
  },
  {
    name: 'Premium+',
    monthly: 15,
    yearly: 90,
    tagline: 'For authors, teams and recruiters.',
    features: [
      'Everything in Premium',
      'Editorial publishing quotas (5 × 100 / month)',
      'Statistics for your posts',
      'Verified user directory',
    ],
    cta: 'Get Premium+',
  },
]

const FAQ = [
  {
    q: 'When does checkout open?',
    a: 'Premium and Premium+ checkout launches with the stage-2 billing integration. Every button on this page is wired to the real API, which will honestly tell you payments are not live yet — nothing is ever charged by mistake.',
  },
  {
    q: 'What does the yearly price mean?',
    a: 'The year is paid once: $30 for Premium and $90 for Premium+. That is exactly 50% cheaper than twelve monthly payments.',
  },
  {
    q: 'Does a donation activate Premium?',
    a: 'No. Donations support the project and never unlock subscriptions or advertising credit. They are separate by design.',
  },
  {
    q: 'Can I cancel?',
    a: 'When billing launches you will be able to cancel renewal anytime and keep access until the end of the paid period.',
  },
]

export function PricingPlans() {
  const { user } = useSession()
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly')

  async function trySubscribe(plan: string) {
    try {
      await api('/api/premium/subscribe', { method: 'POST', body: { plan } })
    } catch (err) {
      // The expected honest 503 — surface the explanation.
      toast.info(err instanceof Error ? err.message : 'Payments are not live yet', {
        description: 'We will email registered users the moment checkout opens.',
      })
    }
  }

  return (
    <div className="container page">
      <section className="pricing-hero">
        <span className="eyebrow">SUPPORT MERKLANE · UNLOCK MORE</span>
        <h1>Simple pricing, honest features.</h1>
        <p>Free forever for readers. Premium adds delivery. Premium+ adds publishing tools.</p>

        <div className="button-row" style={{ justifyContent: 'center', marginTop: 26 }}>
          <div className="row" style={{ gap: 6, background: 'var(--muted)', padding: 4, borderRadius: 9 }}>
            <button
              type="button"
              className={`chip ${billing === 'monthly' ? 'selected' : ''}`}
              style={{ border: 0 }}
              onClick={() => setBilling('monthly')}
            >
              Monthly
            </button>
            <button
              type="button"
              className={`chip ${billing === 'yearly' ? 'selected' : ''}`}
              style={{ border: 0 }}
              onClick={() => setBilling('yearly')}
            >
              Yearly · save 50%
            </button>
          </div>
        </div>
      </section>

      <div className="pricing-grid">
        {PLANS.map((plan) => (
          <div className={`card price-card ${plan.featured ? 'featured' : ''}`} key={plan.name}>
            <div className="row between">
              <h2>{plan.name}</h2>
              {plan.featured ? <span className="badge state-published">Popular</span> : null}
            </div>
            <p className="muted small" style={{ marginTop: 6 }}>
              {plan.tagline}
            </p>
            <div className="price">
              ${billing === 'monthly' ? plan.monthly : plan.yearly}
              <span> /{billing === 'monthly' ? 'month' : 'year'}</span>
            </div>
            <ul className="price-features">
              {plan.features.map((feature) => (
                <li key={feature}>
                  <Check width={17} height={17} aria-hidden /> <span>{feature}</span>
                </li>
              ))}
            </ul>
            {plan.name === 'Free' ? (
              <Link href={user ? '/profile' : '/auth?mode=register'}>
                <Button variant="outline" className="full-width">
                  {user ? 'Your current plan' : 'Create free account'}
                </Button>
              </Link>
            ) : (
              <Button
                className="full-width"
                style={{ background: 'var(--link)', color: '#081219' }}
                onClick={() => void trySubscribe(plan.name)}
              >
                <Sparkles width={15} height={15} /> {plan.cta}
              </Button>
            )}
          </div>
        ))}
      </div>

      <p className="muted small" style={{ textAlign: 'center', marginTop: 18 }}>
        Checkout opens with the stage-2 billing launch. Prices shown are the approved rates and
        will not change at launch.
      </p>

      <section className="faq">
        <h2 style={{ textAlign: 'center', marginBottom: 10 }}>Questions, answered</h2>
        {FAQ.map((item) => (
          <details key={item.q}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </section>
    </div>
  )
}
