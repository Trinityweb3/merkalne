/**
 * Daily statistics block for the About page — renders a StatsSnapshot.
 *
 * PRESENTATION ONLY: every label, window name and number format lives in
 * this file. The snapshot itself (src/lib/stats/types.ts) carries raw
 * numbers + ISO codes, so a future i18n/locale API only needs to translate
 * what this component prints — the data contract never changes. (Today no
 * language endpoint exists, so this renders English, like the whole site.)
 */
import { TrendingUp } from 'lucide-react'
import { SECTION_META, type PostSection } from '@/lib/constants'
import type { StatsSnapshot, VisitorWindow } from '@/lib/stats/types'

const fmt = new Intl.NumberFormat('en-US')

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "October 26, 2026" — always UTC (snapshot dates are UTC midnights). */
function utcDateLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

const WINDOW_META: Record<VisitorWindow, { label: string; compare: string }> = {
  '24h': { label: 'Unique visitors · last 24 hours', compare: 'vs previous day' },
  '7d': { label: 'Unique visitors · last 7 days', compare: 'vs previous week' },
  '30d': { label: 'Unique visitors · last 30 days', compare: 'vs previous month' },
  '365d': { label: 'Unique visitors · last 12 months', compare: 'vs previous year' },
}

const PAGE_BUCKETS: Record<string, string> = {
  home: 'Home',
  about: 'About',
  search: 'Search',
  premium: 'Premium',
  recruiter: 'Premium+ tools',
  ads: 'Ads',
  auth: 'Sign in',
  profile: 'Profile cabinet',
  alerts: 'Alerts',
  contact: 'Contact',
  other: 'Other pages',
}

function sectionLabel(slug: string): string {
  if (slug in SECTION_META) return SECTION_META[slug as PostSection].title
  return PAGE_BUCKETS[slug] ?? slug
}

let displayNames: Intl.DisplayNames | null = null
function countryName(code: string): string {
  if (code === 'XX') return 'Unknown'
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'region' })
    return displayNames.of(code) ?? code
  } catch {
    return code
  }
}

/** % change chip: green up / red down / "new" when no baseline exists yet. */
function Delta({ pct, hasValue }: { pct: number | null; hasValue: boolean }) {
  if (pct === null) {
    return hasValue ? <span className="delta new">new</span> : <span className="delta flat">—</span>
  }
  const up = pct >= 0
  return (
    <span className={`delta ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

function BarRow({ label, share, value, delta }: { label: string; share: number; value: string; delta?: React.ReactNode }) {
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <span className="bar-track" aria-hidden>
        <span className="bar-fill" style={{ width: `${Math.max(share, 1.5)}%` }} />
      </span>
      <span className="bar-value">
        {value}
        {delta ? <span className="bar-delta">{delta}</span> : null}
      </span>
    </div>
  )
}

export function AboutStats({ asOf, snapshot }: { asOf: Date; snapshot: StatsSnapshot }) {
  const newPostsTotal = snapshot.newPostsBySection.reduce((sum, s) => sum + s.count, 0)

  return (
    <section className="section-block" aria-labelledby="about-stats">
      <div className="section-title">
        <div className="row">
          <span className="section-icon">
            <TrendingUp width={18} height={18} />
          </span>
          <div>
            <h2 id="about-stats">Merklane as of {utcDateLabel(asOf)}</h2>
            <p>Updated once a day. Percentages compare each window with the equal-length window before it.</p>
          </div>
        </div>
      </div>

      {/* Visitors: 24h / 7d / 30d / 365d */}
      <div className="stat-grid">
        {snapshot.visitors.map((v) => (
          <div className="stat" key={v.window}>
            <div className="label">{WINDOW_META[v.window].label}</div>
            <div className="value">{fmt.format(v.uniqueVisitors)}</div>
            <div className="detail row" style={{ gap: 8, alignItems: 'center' }}>
              <Delta pct={v.changePct} hasValue={v.uniqueVisitors > 0} />
              {WINDOW_META[v.window].compare}
            </div>
          </div>
        ))}
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        {/* Page views by section (7 days) */}
        <div className="card">
          <h3>Page views by section</h3>
          <p className="muted small" style={{ marginTop: 4 }}>
            Last 7 days, all visitors
          </p>
          {snapshot.viewsBySection.length === 0 ? (
            <p className="muted small" style={{ marginTop: 14 }}>
              No page views recorded in the last 7 days yet.
            </p>
          ) : (
            <div className="bar-list">
              {snapshot.viewsBySection.map((s) => (
                <BarRow key={s.section} label={sectionLabel(s.section)} share={s.sharePct} value={fmt.format(s.views)} />
              ))}
            </div>
          )}
        </div>

        {/* Traffic by country (30 days) */}
        <div className="card">
          <h3>Traffic by country</h3>
          <p className="muted small" style={{ marginTop: 4 }}>
            Last 30 days, unique visitors
          </p>
          {snapshot.countries.length === 0 ? (
            <p className="muted small" style={{ marginTop: 14 }}>
              No countries to report yet.
            </p>
          ) : (
            <div className="bar-list">
              {snapshot.countries.map((c) => (
                <BarRow
                  key={c.code}
                  label={countryName(c.code)}
                  share={c.sharePct}
                  value={fmt.format(c.visitors)}
                  delta={c.changePct === null ? undefined : <Delta pct={c.changePct} hasValue />}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        {/* New posts (24h) */}
        <div className="card">
          <h3>New posts in the last 24 hours</h3>
          {newPostsTotal === 0 ? (
            <p className="muted small" style={{ marginTop: 12 }}>
              Nothing was published in the last 24 hours — fresh material lands with the next editorial pass.
            </p>
          ) : (
            <ul className="kv-list">
              {snapshot.newPostsBySection.map((s) => (
                <li key={s.section}>
                  <span>{sectionLabel(s.section)}</span>
                  <b>{fmt.format(s.count)}</b>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Premium & partners */}
        <div className="card">
          <h3>Premium & partners</h3>
          <ul className="kv-list">
            <li>
              <span>Premium subscribers, active</span>
              <b>{fmt.format(snapshot.premium.premium)}</b>
            </li>
            <li>
              <span>
                Premium+ subscribers, active{' '}
                <span className="muted small">(plan launches with billing)</span>
              </span>
              <b>{fmt.format(snapshot.premium.premiumPlus)}</b>
            </li>
            <li>
              <span>
                Ad campaigns running <span className="muted small">(Ads is in waitlist stage)</span>
              </span>
              <b>{fmt.format(snapshot.advertisers.activeCampaigns)}</b>
            </li>
            <li>
              <span>Advertisers on the waitlist</span>
              <b>{fmt.format(snapshot.advertisers.waitlist)}</b>
            </li>
          </ul>
          <p className="muted small" style={{ marginTop: 12 }}>
            Site totals: {fmt.format(snapshot.totals.publishedPosts)} published posts ·{' '}
            {fmt.format(snapshot.totals.comments)} comments · {fmt.format(snapshot.totals.users)} registered users
          </p>
        </div>
      </div>

      <p className="muted small" style={{ marginTop: 14, lineHeight: 1.7 }}>
        Methodology: unique visitors are counted with an anonymous, irreversible fingerprint — no accounts, raw
        addresses or cross-site tracking are involved. Countries come from network geo headers and report
        “Unknown” when the network provides none. One snapshot is computed per day by the Merklane worker; an
        admin can refresh it on demand.
      </p>
    </section>
  )
}
