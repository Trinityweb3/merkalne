import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { latestBySection, serializePost } from '@/lib/posts'
import { localizePostList } from '@/lib/localize'
import { EDITORIAL_SECTIONS, SECTION_META } from '@/lib/constants'
import { SearchBox } from '@/components/site/search-box'
import { SectionHead } from '@/components/site/section-head'
import { PostGrid } from '@/components/site/post-grid'
import { SupportBanner } from '@/components/site/support-banner'
import { VisitorSafety } from '@/components/site/visitor-safety'

export const dynamic = 'force-dynamic'

const QUICK_LINK_HREFS = [
  '/search?q=remote',
  '/search?q=frontend%20intern',
  '/search?q=solana',
  '/search?q=btc%20volume',
  '/search?period=24h',
] as const

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'hero' })
  const tq = await getTranslations({ locale, namespace: 'quickLinks' })
  const ts = await getTranslations({ locale, namespace: 'sections' })
  const tb = await getTranslations({ locale, namespace: 'blog' })

  const QUICK_LINKS = [
    { label: tq('remoteJobs'), href: QUICK_LINK_HREFS[0] },
    { label: tq('frontendIntern'), href: QUICK_LINK_HREFS[1] },
    { label: tq('solana'), href: QUICK_LINK_HREFS[2] },
    { label: tq('btcVolume'), href: QUICK_LINK_HREFS[3] },
    { label: tq('addedToday'), href: QUICK_LINK_HREFS[4] },
  ]

  // Latest three published posts per working section (Blog included).
  const sections = [...EDITORIAL_SECTIONS, 'blog' as const]
  const rawRails = await Promise.all(sections.map((section) => latestBySection(section, 3)))
  // Localized titles for the rails (DB cache → LibreTranslate → English).
  const rails = await Promise.all(rawRails.map((rail) => localizePostList(rail, locale)))

  return (
    <>
      <VisitorSafety />
      {/* `page` (top padding) is intentionally omitted: the hero band carries
          its own vertical rhythm and should sit directly under the header. */}
      <div className="container">
        <section className="hero">
          <span className="eyebrow">{t('eyebrow')}</span>
          <h1 style={{ marginTop: 13 }}>{t('title')}</h1>
          <p className="hero-sub muted">{t('subtitle')}</p>

          <SearchBox />

          <div className="quick-links">
            {QUICK_LINKS.map((chip) => (
              <Link key={chip.href} href={chip.href} className="chip">
                {chip.label}
              </Link>
            ))}
          </div>
        </section>

        {sections.map((section, i) => (
          <section className="section-block" key={section} aria-labelledby={`section-${section}`}>
            {/* Section NAMES stay English in every locale (functional
                identifiers); this sr-only label just repeats the heading. */}
            <span id={`section-${section}`} className="sr-only">
              {SECTION_META[section].title}
            </span>
            <SectionHead section={section} />
            <PostGrid
              posts={rails[i].map(serializePost)}
              homeGrid
              emptyTitle={tb('sectionNoPosts', { section: SECTION_META[section].title })}
              emptyText={section === 'blog' ? ts('emptyBlog') : ts('emptyEditorial')}
            />
          </section>
        ))}

        <SupportBanner />
      </div>
    </>
  )
}
