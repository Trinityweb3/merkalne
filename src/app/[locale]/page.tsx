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

const QUICK_LINKS = [
  { label: 'Remote jobs', href: '/search?q=remote' },
  { label: 'Frontend Intern', href: '/search?q=frontend%20intern' },
  { label: 'Solana', href: '/search?q=solana' },
  { label: 'BTC volume', href: '/search?q=btc%20volume' },
  { label: 'Added today', href: '/search?period=24h' },
]

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
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
          <span className="eyebrow">WEB3 · CRYPTO · BLOCKCHAIN · AI</span>
          <h1 style={{ marginTop: 13 }}>Find what&rsquo;s next.</h1>
          <p className="hero-sub muted">Jobs, opportunities and insights. All in one place.</p>

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
            <span id={`section-${section}`} className="sr-only">
              {SECTION_META[section].title}
            </span>
            <SectionHead section={section} />
            <PostGrid
              posts={rails[i].map(serializePost)}
              homeGrid
              emptyTitle={`No ${SECTION_META[section].title} material yet`}
              emptyText={
                section === 'blog'
                  ? 'Registered users can publish here for free — be the first.'
                  : 'This section fills up as the editorial team publishes.'
              }
            />
          </section>
        ))}

        <SupportBanner />
      </div>
    </>
  )
}
