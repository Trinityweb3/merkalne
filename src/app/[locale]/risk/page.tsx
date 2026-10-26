import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { ShieldAlert } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Safety & risk',
  description: 'How to spot scams in Web3 opportunities and how Merklane helps you stay safe.',
}

const RED_FLAGS = [
  'Upfront payment to “activate” a job, unlock a reward or cover “gas”',
  'Requests to install unknown software, screen-sharing tools or browser extensions',
  'Wallet connection or seed-phrase requests — no legitimate employer ever needs these',
  'Guaranteed returns, fixed APY on “risk-free” tasks, or airdrops that require a deposit',
  'Urgency pressure (“only 3 slots left, decide in 10 minutes”)',
  'Recruitment conducted exclusively through Telegram DMs with no verifiable company',
]

export default function RiskPage() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <h1>Safety &amp; risk</h1>
          <p>
            Merklane aggregates third-party information. We label, link and moderate — but the
            internet is creative, so the final filter is always yours. Here is the short version
            of staying safe.
          </p>
        </div>
      </div>

      <div className="narrow stack" style={{ gap: 26 }}>
        <section className="card">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <ShieldAlert width={22} height={22} style={{ color: 'var(--link)', marginTop: 2 }} />
            <div>
              <h3 style={{ fontSize: '1.15rem' }}>Red flags — walk away when you see them</h3>
              <ul className="muted small" style={{ display: 'grid', gap: 10, marginTop: 12, listStyle: 'outside', paddingLeft: 20, lineHeight: 1.7 }}>
                {RED_FLAGS.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: '1.25rem' }}>How Merklane helps</h2>
          <div className="stack" style={{ gap: 12, marginTop: 12 }}>
            <p className="muted" style={{ lineHeight: 1.75, fontSize: '0.95rem' }}>
              Every post keeps its original source link so you can verify where it came from.
              Missing fields say “not provided” rather than inventing numbers. A one-click report
              button on every post reaches the moderation queue without requiring registration.
            </p>
            <p className="muted" style={{ lineHeight: 1.75, fontSize: '0.95rem' }}>
              A safety reminder appears once on your first visit and permanently in the footer of
              every page — we deliberately do not repeat a large warning inside every article.
            </p>
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: '1.25rem' }}>If something went wrong</h2>
          <p className="muted" style={{ lineHeight: 1.75, fontSize: '0.95rem', marginTop: 12 }}>
            Stop all communication, do not send further funds, disconnect wallet approvals you
            granted (revoke.cash and similar tools can help), and preserve evidence. Then{' '}
            <Link href="/contact" className="link">
              tell us
            </Link>{' '}
            so the material can be reviewed and labelled for the next reader. When in doubt,
            report first and decide later — reports are free and reviewed by humans.
          </p>
        </section>
      </div>
    </div>
  )
}
