import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { ContactForm } from '@/components/site/contact-form'

export const metadata: Metadata = {
  title: 'Premium+ tools',
  description:
    'Editorial publishing quotas, post statistics and the verified user directory — Premium+ tools for authors, teams and recruiters.',
}

export default function RecruiterPage() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <h1>Premium+ tools</h1>
          <p>
            For authors, projects, teams and recruiters: publish across the editorial sections,
            measure what works, and search the verified directory.
          </p>
        </div>
      </div>

      <div className="paywall" style={{ marginBottom: 30 }}>
        <span className="eyebrow">STAGE 2 · ARRIVING WITH BILLING</span>
        <h2 style={{ marginTop: 12 }}>Five independent quotas. Real statistics. Verified people.</h2>
        <p>
          Premium+ unlocks five independent quotas of 100 editorial publications per month — one
          each for Intern/Junior, Mid/Senior, Opportunities, Markets and Insights — plus
          view-through statistics for your posts and the searchable directory of members who opted
          in. The Blog stays free and never consumes quota.
        </p>
        <p>
          To keep this page honest: checkout is not live yet. Pricing is fixed at $15/month or
          $90/year (50% off monthly) and will not change at launch. Real quota counters and
          directory rows are delivered only to active subscribers — never hidden behind a blurred
          overlay.
        </p>
        <div className="button-row" style={{ marginTop: 22 }}>
          <Link href="/premium">
            <Button style={{ background: 'var(--link)', color: '#081219' }}>
              See the full plan comparison
            </Button>
          </Link>
          <Link href="/profile/ads">
            <Button variant="outline">Advertise instead — Merklane Ads</Button>
          </Link>
        </div>
      </div>

      <div className="quota-grid">
        <div className="card quota-card">
          <h3>Intern/Junior</h3>
          <div className="value">100<span className="muted small" style={{ fontWeight: 400 }}>/mo</span></div>
          <p className="muted tiny">Independent quota</p>
        </div>
        <div className="card quota-card">
          <h3>Mid/Senior</h3>
          <div className="value">100<span className="muted small" style={{ fontWeight: 400 }}>/mo</span></div>
          <p className="muted tiny">Independent quota</p>
        </div>
        <div className="card quota-card">
          <h3>Opportunities</h3>
          <div className="value">100<span className="muted small" style={{ fontWeight: 400 }}>/mo</span></div>
          <p className="muted tiny">Independent quota</p>
        </div>
        <div className="card quota-card">
          <h3>Markets</h3>
          <div className="value">100<span className="muted small" style={{ fontWeight: 400 }}>/mo</span></div>
          <p className="muted tiny">Independent quota</p>
        </div>
        <div className="card quota-card">
          <h3>Insights</h3>
          <div className="value">100<span className="muted small" style={{ fontWeight: 400 }}>/mo</span></div>
          <p className="muted tiny">Independent quota</p>
        </div>
        <div className="card quota-card">
          <h3>Blog</h3>
          <div className="value">∞</div>
          <p className="muted tiny">Always free, never consumes quota</p>
        </div>
      </div>

      <section style={{ maxWidth: 760 }}>
        <h2 style={{ marginBottom: 14 }}>Interested before launch?</h2>
        <ContactForm />
      </section>
    </div>
  )
}
