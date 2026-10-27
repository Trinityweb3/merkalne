/**
 * Daily statistics block for the About page — renders a StatsSnapshot.
 *
 * PRESENTATION ONLY: every label and number format lives in this file or in
 * the `about` dictionary namespace (src/i18n/messages/*.ts). The snapshot
 * itself (src/lib/stats/types.ts) carries raw numbers + ISO codes, so the
 * data contract never changes — only what this component prints is
 * localized. Numbers and dates format with the active locale (e.g. native
 * digits for ar/fa), falling back to en where Intl data is missing.
 */
import { useLocale, useTranslations } from 'next-intl'
import { TrendingUp } from 'lucide-react'
import { SECTION_META, type PostSection } from '@/lib/constants'
import type { StatsSnapshot, VisitorWindow } from '@/lib/stats/types'

type VisitorWindowKey = Record<VisitorWindow, 'visitors24h' | 'visitors7d' | 'visitors30d' | 'visitors365d'>
const WINDOW_LABEL_KEYS: VisitorWindowKey = {
  '24h': 'visitors24h',
  '7d': 'visitors7d',
  '30d': 'visitors30d',
  '365d': 'visitors365d',
}
const WINDOW_COMPARE_KEYS: Record<VisitorWindow, 'vsDay' | 'vsWeek' | 'vsMonth' | 'vsYear'> = {
  '24h': 'vsDay',
  '7d': 'vsWeek',
  '30d': 'vsMonth',
  '365d': 'vsYear',
}

/** Page-bucket labels — the `about` namespace keys (non-section pages). */
const BUCKET_KEYS: Record<string, string> = {
  home: 'bucket_home',
  about: 'bucket_about',
  search: 'bucketSearch',
  premium: 'bucketPremium',
  recruiter: 'bucketRecruiter',
  ads: 'bucketAds',
  auth: 'bucketAuth',
  profile: 'bucketProfile',
  alerts: 'bucketAlerts',
  contact: 'bucketContact',
  other: 'bucketOther',
}

function Delta({ pct, hasValue }: { pct: number | null; hasValue: boolean }) {
  const t = useTranslations('about')
  if (pct === null) {
    return hasValue ? (
      <span className="delta new">{t('newChip')}</span>
    ) : (
      <span className="delta flat">—</span>
    )
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
  const t = useTranslations('about')
  const locale = useLocale()
  // Locale-aware formatting with a safe fallback for exotic Intl data.
  const fmt = new Intl.NumberFormat(locale)
  const dateLabel = new Intl.DateTimeFormat(locale, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(asOf)

  /** Section names stay English (functional identifiers); other buckets localize. */
  const sectionLabel = (slug: string): string => {
    if (slug in SECTION_META) return SECTION_META[slug as PostSection].title
    const key = BUCKET_KEYS[slug]
    return key ? t(key as Parameters<typeof t>[0]) : slug
  }

  let displayNames: Intl.DisplayNames | null = null
  const countryName = (code: string): string => {
    if (code === 'XX') return t('unknownCountry')
    try {
      displayNames ??= new Intl.DisplayNames([locale], { type: 'region' })
      return displayNames.of(code) ?? code
    } catch {
      return code
    }
  }

  const newPostsTotal = snapshot.newPostsBySection.reduce((sum, s) => sum + s.count, 0)

  return (
    <section className="section-block" aria-labelledby="about-stats">
      <div className="section-title">
        <div className="row">
          <span className="section-icon">
            <TrendingUp width={18} height={18} />
          </span>
          <div>
            <h2 id="about-stats" style={{ marginBottom: 8 }}>{t('statsTitle', { date: dateLabel })}</h2>
            <p>{t('statsSub')}</p>
          </div>
        </div>
      </div>

      {/* Visitors: 24h / 7d / 30d / 365d */}
      <div className="stat-grid">
        {snapshot.visitors.map((v) => (
          <div className="stat" key={v.window}>
            <div className="label">{t(WINDOW_LABEL_KEYS[v.window])}</div>
            <div className="value">{fmt.format(v.uniqueVisitors)}</div>
            <div className="detail row" style={{ gap: 8, alignItems: 'center' }}>
              <Delta pct={v.changePct} hasValue={v.uniqueVisitors > 0} />
              {t(WINDOW_COMPARE_KEYS[v.window])}
            </div>
          </div>
        ))}
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        {/* Page views by section (7 days) */}
        <div className="card">
          <h3>{t('viewsTitle')}</h3>
          <p className="muted small" style={{ marginTop: 4 }}>
            {t('viewsSub')}
          </p>
          {snapshot.viewsBySection.length === 0 ? (
            <p className="muted small" style={{ marginTop: 14 }}>
              {t('viewsEmpty')}
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
          <h3>{t('countriesTitle')}</h3>
          <p className="muted small" style={{ marginTop: 4 }}>
            {t('countriesSub')}
          </p>
          {snapshot.countries.length === 0 ? (
            <p className="muted small" style={{ marginTop: 14 }}>
              {t('countriesEmpty')}
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
          <h3>{t('newPostsTitle')}</h3>
          {newPostsTotal === 0 ? (
            <p className="muted small" style={{ marginTop: 12 }}>
              {t('newPostsEmpty')}
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
          <h3>{t('premiumTitle')}</h3>
          <ul className="kv-list">
            <li>
              <span>{t('premiumActive')}</span>
              <b>{fmt.format(snapshot.premium.premium)}</b>
            </li>
            <li>
              <span>
                {t('premiumPlusActive')}{' '}
                <span className="muted small">{t('planBilling')}</span>
              </span>
              <b>{fmt.format(snapshot.premium.premiumPlus)}</b>
            </li>
            <li>
              <span>
                {t('campaignsRunning')} <span className="muted small">{t('adsWaitlistNote')}</span>
              </span>
              <b>{fmt.format(snapshot.advertisers.activeCampaigns)}</b>
            </li>
            <li>
              <span>{t('advertisersWaitlist')}</span>
              <b>{fmt.format(snapshot.advertisers.waitlist)}</b>
            </li>
          </ul>
          <p className="muted small" style={{ marginTop: 12 }}>
            {t('siteTotals', {
              posts: fmt.format(snapshot.totals.publishedPosts),
              comments: fmt.format(snapshot.totals.comments),
              users: fmt.format(snapshot.totals.users),
            })}
          </p>
        </div>
      </div>

      <p className="muted small" style={{ marginTop: 14, lineHeight: 1.7 }}>
        {t('methodology')}
      </p>
    </section>
  )
}
