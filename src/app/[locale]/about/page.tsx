import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { Compass, FileText, Globe, ShieldCheck, Sparkles, Users, Video } from 'lucide-react'
import { getLatestDailyStats } from '@/lib/stats/aggregate'
import { activeTranslationProvider } from '@/lib/translate'
import { AboutStats } from '@/components/site/about-stats'
import { YoutubeEmbed } from '@/components/site/youtube-embed'
import { Button } from '@/components/ui/button'
import { MONTHLY_RECAPS, PITCH_DECK, TEAM_MEMBERS, type TeamMember } from '@/lib/about-content'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'About',
  description:
    'What Merklane is, who builds it, and how the site is doing — live statistics updated once a day: visitors, sections, countries, premium subscribers and more.',
}

const PILLARS = [
  {
    icon: Compass,
    title: 'One place, six sections',
    text: 'Intern/Junior, Mid/Senior, Opportunities, Markets, Insights and the community Blog. Material keeps its mosaic cards and full context instead of scattered screenshots.',
  },
  {
    icon: Globe,
    title: 'Twenty languages',
    text: 'The interface and published material cover all 20 supported languages — including right-to-left Arabic, Persian and Urdu.',
  },
  {
    icon: ShieldCheck,
    title: 'Honesty first',
    text: 'Missing salary means “not provided”, never zero. Nothing is invented: no fake charts, no fictional campaigns, no promised airdrops. What is not live yet says so.',
  },
  {
    icon: Sparkles,
    title: 'Free core, paid extras',
    text: 'Reading, search, bookmarks, comments and Blog publishing are free forever. Premium adds delivery; Premium+ adds publishing tools for teams.',
  },
]

/** Initials avatar with a deterministic per-name gradient — no assets needed. */
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

function TeamCard({ member }: { member: TeamMember }) {
  return (
    <div className="card team-card">
      <div className="row" style={{ gap: 14, alignItems: 'center' }}>
        <TeamAvatar name={member.name} imageUrl={member.imageUrl} />
        <div style={{ minWidth: 0 }}>
          <h3>{member.name}</h3>
          <p className="team-role">{member.role}</p>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 14, lineHeight: 1.7 }}>
        {member.bio}
      </p>
      {member.links.length > 0 ? (
        <div className="team-links">
          {member.links.map((l) =>
            l.url.startsWith('/') ? (
              <Link key={l.url} href={l.url} className="chip">
                {l.label}
              </Link>
            ) : (
              <a
                key={l.url}
                href={l.url}
                className="chip"
                target="_blank"
                rel="noopener noreferrer"
              >
                {l.label}
              </a>
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

export default async function AboutPage() {
  const latest = await getLatestDailyStats()
  const translationProvider = activeTranslationProvider()

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
          <h1>About Merklane</h1>
          <p>
            Merklane exists because Web3 opportunities are scattered, noisy and often misleading. We collect
            them in one place, label what is known, admit what is not, and let you decide with full context.
            This page also shows who is behind the project — and, updated once a day, how the site is doing.
          </p>
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
            <span>
              Live statistics appear here after the first daily snapshot (computed automatically around
              03:00 UTC — an admin can also trigger one on demand). The anonymous counters have already
              started collecting. Until then this page stays honest instead of showing made-up zeros.
            </span>
          </div>
        </section>
      )}

      {/* Tiny indicator: which translation engine serves the 19 non-English
          locales (server-side config — hidden when translation is off). */}
      {translationProvider ? (
        <p className="muted small" style={{ marginTop: -6, lineHeight: 1.7 }}>
          Translation via {translationProvider.label}
          {translationProvider.model ? ` · ${translationProvider.model}` : ''} — results are cached per
          language after the first view.
        </p>
      ) : null}

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
              <h2>The people behind Merklane</h2>
              <p>A small, deliberate team — here are the accounts behind the project.</p>
            </div>
          </div>
        </div>
        <div className="grid-3">
          {TEAM_MEMBERS.map((member) => (
            <TeamCard key={member.name} member={member} />
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* What makes Merklane different                                      */}
      {/* ------------------------------------------------------------------ */}
      <section className="section-block">
        <div className="section-title">
          <div className="row">
            <div>
              <h2>What makes Merklane different</h2>
              <p>Four rules the project is built on.</p>
            </div>
          </div>
        </div>
        <div className="grid-2">
          {PILLARS.map(({ icon: Icon, title, text }) => (
            <div className="card" key={title}>
              <div className="row" style={{ gap: 12 }}>
                <span className="section-icon">
                  <Icon width={18} height={18} />
                </span>
                <h3>{title}</h3>
              </div>
              <p className="muted small" style={{ marginTop: 12, lineHeight: 1.7 }}>
                {text}
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
              <h2>What you can do today</h2>
              <p>The current launch covers the full editorial experience.</p>
            </div>
          </div>
        </div>
        <div className="grid-2">
          <div className="card">
            <h3>For readers and hunters</h3>
            <ul
              className="muted small"
              style={{ display: 'grid', gap: 10, marginTop: 10, listStyle: 'outside', paddingLeft: 20 }}
            >
              <li>Browse and filter all six sections on any device</li>
              <li>Search editorial material with exact hashtag support</li>
              <li>Save posts for free — synced across your devices</li>
              <li>React, comment and report suspicious material</li>
            </ul>
          </div>
          <div className="card">
            <h3>For community authors</h3>
            <ul
              className="muted small"
              style={{ display: 'grid', gap: 10, marginTop: 10, listStyle: 'outside', paddingLeft: 20 }}
            >
              <li>Publish in the Blog for free with drafts and previews</li>
              <li>Keep ownership — edit or remove your posts anytime</li>
              <li>Reach readers across all 20 languages</li>
              <li>
                Editorial publishing quotas arrive with{' '}
                <Link href="/premium" className="link">
                  Premium+
                </Link>
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
              <h2>Monthly recaps</h2>
              <p>Each month: what happened on Merklane, what is next, and how you can support us.</p>
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
                <h3>First recap after the first full month</h3>
                <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
                  Every month we publish a short video: the month in numbers, what worked, what is coming,
                  and how the project can be supported. The first recap lands here as soon as the first
                  full month closes — nothing is teased before it exists.
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
              <h2>Pitch deck</h2>
              <p>For investors: what the funding is for and what it costs to run Merklane.</p>
            </div>
          </div>
        </div>
        <div className="card pitch-card">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span className="section-icon" style={{ flexShrink: 0 }}>
              <FileText width={18} height={18} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h3>Merklane investor deck</h3>
              <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
                {PITCH_DECK.note ??
                  'What the funding is for, site expenses, roadmap and results — updated with every monthly recap.'}
              </p>
            </div>
          </div>
          {PITCH_DECK.url ? (
            <Button asChild>
              <a href={PITCH_DECK.url} target="_blank" rel="noopener noreferrer">
                Open the deck (PDF)
              </a>
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href="/contact">Request the deck</Link>
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
            Merklane is an information service, not an employer, exchange or financial adviser. Every listing
            reflects its original source — always verify before sharing personal data, sending funds or
            connecting a wallet. Read the{' '}
            <Link href="/risk" className="link">
              safety notice
            </Link>{' '}
            and{' '}
            <Link href="/contact" className="link">
              tell us
            </Link>{' '}
            when something looks wrong.
          </span>
        </div>
      </section>
    </div>
  )
}
