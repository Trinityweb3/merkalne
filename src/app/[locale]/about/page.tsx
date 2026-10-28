import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Compass, FileText, Globe, ShieldCheck, Sparkles, Users, Video } from 'lucide-react'
import { getLatestDailyStats } from '@/lib/stats/aggregate'
import { getSiteOverrides, type TeamMemberOverride } from '@/lib/site-settings'
import { AboutStats } from '@/components/site/about-stats'
import { YoutubeEmbed } from '@/components/site/youtube-embed'
import { Button } from '@/components/ui/button'
import { MONTHLY_RECAPS, PITCH_DECK, TEAM_MEMBERS, type TeamMember } from '@/lib/about-content'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ locale: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'about' })
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  }
}

const PILLARS = [
  { icon: Compass, titleKey: 'pillar1Title', textKey: 'pillar1Text' },
  { icon: Globe, titleKey: 'pillar2Title', textKey: 'pillar2Text' },
  { icon: ShieldCheck, titleKey: 'pillar3Title', textKey: 'pillar3Text' },
  { icon: Sparkles, titleKey: 'pillar4Title', textKey: 'pillar4Text' },
] as const

/** "October 2026" for future recap entries (owner-supplied content). */
function utcMonthYear(iso: string): string {
  const d = new Date(iso)
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

function TeamAvatar({ name, imageUrl }: { name: string; imageUrl?: string }) {
  if (imageUrl) {
    return <img className="team-avatar" src={imageUrl} alt={name} width={56} height={56} />
  }
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  const hue = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)
  return (
    <span
      className="team-avatar team-avatar-initials"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 45) % 360} 55% 30%))` }}
      aria-hidden
    >
      {initials || '?'}
    </span>
  )
}

/**
 * One team card. The avatar/bio shown are the RUNTIME values: the Telegram
 * admin bot's upload (SiteSetting override) wins over the static placeholder
 * in about-content.ts, which wins over the localized placeholder text. When
 * the member has a social link the WHOLE card becomes the link (opens in a
 * new tab; the aria-label announces it); without a link it renders as a
 * plain, non-clickable card.
 */
function TeamCard({
  member,
  role,
  bio,
  imageUrl,
  openLabel,
}: {
  member: TeamMember
  role: string
  bio: string
  imageUrl?: string
  openLabel: string
}) {
  const body = (
    <>
      <div className="row" style={{ gap: 14, alignItems: 'center' }}>
        <TeamAvatar name={member.name} imageUrl={imageUrl} />
        <div style={{ minWidth: 0 }}>
          <h3>{member.name}</h3>
          <p className="team-role">{role}</p>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 14, lineHeight: 1.7 }}>
        {bio}
      </p>
    </>
  )

  if (member.socialUrl) {
    return (
      <a
        className="card team-card"
        href={member.socialUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={openLabel}
      >
        {body}
      </a>
    )
  }
  return <div className="card team-card">{body}</div>
}

export default async function AboutPage({ params }: PageProps) {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'about' })
  const latest = await getLatestDailyStats()
  // Operator-managed content (Telegram admin bot uploads): site logo + team
  // avatar/bio overrides. 60 s cache — safe to read on every request.
  const overrides = await getSiteOverrides()
  const teamOverride = (key: TeamMember['settingKey']): TeamMemberOverride =>
    overrides.team[key] ?? {}

  return (
    // Inline fallback mirrors .container (globals.css): even if the stylesheet
    // fails to load or arrives stale, the page stays a centered column instead
    // of stretching edge-to-edge.
    <div
      className="container page"
      style={{ width: 'min(1320px, 100% - 32px)', marginInline: 'auto' }}
    >
      <div className="page-head">
        <div>
          {/* Operator logo (Telegram bot "Change logo") — hidden until the
              first upload lands, so the page stays honest by default. */}
          {overrides.logo ? (
            <img
              className="site-logo"
              src={overrides.logo}
              alt="Merklane"
              width={160}
              height={160}
            />
          ) : null}
          <h1>{t('title')}</h1>
          <p>{t('intro')}</p>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Daily statistics (computed by the worker once per UTC day)          */}
      {/* ------------------------------------------------------------------ */}
      {latest ? (
        <AboutStats asOf={latest.date} snapshot={latest.data} />
      ) : (
        <section className="section-block">
          <div className="notice" style={{ marginBottom: 0 }}>
            <ShieldCheck width={18} height={18} aria-hidden />
            <span>{t('statsPending')}</span>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Team                                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="section-block">
        <div className="section-title">
          <div className="row">
            <span className="section-icon">
              <Users width={18} height={18} />
            </span>
            <div>
              <h2 style={{ marginBottom: 8 }}>{t('teamTitle')}</h2>
              <p style={{ marginBottom: 8 }}>{t('teamSub')}</p>
            </div>
          </div>
        </div>
        <div className="grid-3" style={{ marginTop: 8 }}>
          {TEAM_MEMBERS.map((member) => {
            const o = teamOverride(member.settingKey)
            return (
              <TeamCard
                key={member.name}
                member={member}
                role={t(member.roleKey)}
                imageUrl={o.avatar ?? member.imageUrl}
                bio={o.bio?.trim() ? o.bio : member.bio?.trim() ? member.bio : t('bioPlaceholder')}
                openLabel={t('openProfile', { name: member.name })}
              />
            )
          })}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* What makes Merklane different                                      */}
      {/* ------------------------------------------------------------------ */}
      <section className="section-block">
        <div className="section-title">
          <div className="row">
            <div>
              <h2 style={{ marginBottom: 8 }}>{t('pillarsTitle')}</h2>
              <p style={{ marginBottom: 8 }}>{t('pillarsSub')}</p>
            </div>
          </div>
        </div>
        <div className="grid-2" style={{ marginTop: 8 }}>
          {PILLARS.map(({ icon: Icon, titleKey, textKey }) => (
            <div className="card" key={titleKey}>
              <div className="row" style={{ gap: 12 }}>
                <span className="section-icon">
                  <Icon width={18} height={18} />
                </span>
                <h3>{t(titleKey)}</h3>
              </div>
              <p className="muted small" style={{ marginTop: 12, lineHeight: 1.7 }}>
                {t(textKey)}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* What you can do today                                              */}
      {/* ------------------------------------------------------------------ */}
      <section className="section-block">
        <div className="section-title">
          <div className="row">
            <div>
              <h2 style={{ marginBottom: 8 }}>{t('todayTitle')}</h2>
              <p style={{ marginBottom: 8 }}>{t('todaySub')}</p>
            </div>
          </div>
        </div>
        <div className="grid-2" style={{ marginTop: 8 }}>
          <div className="card">
            <h3>{t('readersTitle')}</h3>
            <ul
              className="muted small"
              style={{ display: 'grid', gap: 10, marginTop: 10, listStyle: 'outside', paddingLeft: 20 }}
            >
              <li>{t('readers1')}</li>
              <li>{t('readers2')}</li>
              <li>{t('readers3')}</li>
              <li>{t('readers4')}</li>
            </ul>
          </div>
          <div className="card">
            <h3>{t('authorsTitle')}</h3>
            <ul
              className="muted small"
              style={{ display: 'grid', gap: 10, marginTop: 10, listStyle: 'outside', paddingLeft: 20 }}
            >
              <li>{t('authors1')}</li>
              <li>{t('authors2')}</li>
              <li>{t('authors3')}</li>
              <li>
                {t.rich('authors4', {
                  // The <premiumPlus> tag renders as a link to /premium.
                  premiumPlus: (chunks) => (
                    <Link href="/premium" className="link">
                      {chunks}
                    </Link>
                  ),
                })}
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Monthly recap videos                                               */}
      {/* ------------------------------------------------------------------ */}
      <section className="section-block">
        <div className="section-title">
          <div className="row">
            <span className="section-icon">
              <Video width={18} height={18} />
            </span>
            <div>
              <h2 style={{ marginBottom: 8 }}>{t('recapsTitle')}</h2>
              <p style={{ marginBottom: 8 }}>{t('recapsSub')}</p>
            </div>
          </div>
        </div>
        {MONTHLY_RECAPS.length === 0 ? (
          <div className="card">
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <span className="section-icon" style={{ flexShrink: 0 }}>
                <Video width={18} height={18} />
              </span>
              <div>
                <h3>{t('recapTitle')}</h3>
                <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
                  {t('recapText')}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid-2">
            {MONTHLY_RECAPS.map((recap) => (
              <div className="card video-card" key={recap.youtubeId}>
                <YoutubeEmbed id={recap.youtubeId} title={recap.title} />
                <h3 style={{ marginTop: 14 }}>{recap.title}</h3>
                <p className="muted small" style={{ marginTop: 6 }}>
                  {utcMonthYear(recap.publishedAt)}
                  {recap.description ? ` — ${recap.description}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Pitch deck                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section className="section-block">
        <div className="section-title">
          <div className="row">
            <span className="section-icon">
              <FileText width={18} height={18} />
            </span>
            <div>
              <h2 style={{ marginBottom: 8 }}>{t('pitchTitle')}</h2>
              <p style={{ marginBottom: 8 }}>{t('pitchSub')}</p>
            </div>
          </div>
        </div>
        <div className="card pitch-card">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span className="section-icon" style={{ flexShrink: 0 }}>
              <FileText width={18} height={18} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h3>{t('pitchCardTitle')}</h3>
              <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
                {PITCH_DECK.note ?? t('pitchNote')}
              </p>
            </div>
          </div>
          {PITCH_DECK.url ? (
            <Button asChild>
              <a href={PITCH_DECK.url} target="_blank" rel="noopener noreferrer">
                {t('openDeck')}
              </a>
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href="/contact">{t('requestDeck')}</Link>
            </Button>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Safety notice                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section className="section-block">
        <div className="notice">
          <ShieldCheck width={18} height={18} aria-hidden />
          <span>
            {t.rich('safetyText', {
              // <risk> → link to /risk, <contact> → link to /contact.
              risk: (chunks) => (
                <Link href="/risk" className="link">
                  {chunks}
                </Link>
              ),
              contact: (chunks) => (
                <Link href="/contact" className="link">
                  {chunks}
                </Link>
              ),
            })}
          </span>
        </div>
      </section>
    </div>
  )
}
