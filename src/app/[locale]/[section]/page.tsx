import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { listPosts, serializePost } from '@/lib/posts'
import { localizePostList } from '@/lib/localize'
import { POST_SECTIONS, SECTION_META, type PostSection } from '@/lib/constants'
import { SECTION_FILTERS } from '@/lib/section-filters'
import type { Messages } from '@/i18n/messages/en'
import { postListQuerySchema } from '@/lib/validation'
import { SectionFilters } from '@/components/site/section-filters'
import { PostListClient } from '@/components/site/post-list-client'
import { SupportBanner } from '@/components/site/support-banner'
import { SECTION_ICONS } from '@/components/site/section-head'

interface PageProps {
  params: Promise<{ locale: string; section: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function isSection(value: string): value is PostSection {
  return (POST_SECTIONS as readonly string[]).includes(value)
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { section } = await params
  if (!isSection(section)) return {}
  const meta = SECTION_META[section]
  return {
    title: meta.title,
    description: meta.description,
    // Blog is intentionally excluded from search indexes (product rule).
    ...(section === 'blog' ? { robots: { index: false, follow: true } } : {}),
  }
}

export default async function SectionPage({ params, searchParams }: PageProps) {
  const { locale, section } = await params
  if (!isSection(section)) notFound()
  const meta = SECTION_META[section]
  const Icon = SECTION_ICONS[section]
  const t = await getTranslations({ locale, namespace: 'common' })
  const tb = await getTranslations({ locale, namespace: 'blog' })
  const ts = await getTranslations({ locale, namespace: 'sections' })
  // Section descriptions live in the `sections` namespace; the TITLE stays
  // English everywhere (functional identifier).
  const SECTION_DESC_KEYS: Record<PostSection, keyof Messages['sections']> = {
    'intern-junior': 'internJuniorDesc',
    'mid-senior': 'midSeniorDesc',
    opportunities: 'opportunitiesDesc',
    markets: 'marketsDesc',
    insights: 'insightsDesc',
    blog: 'blogDesc',
  }

  const query = postListQuerySchema.parse({
    section,
    pageSize: 9,
    ...Object.fromEntries(
      Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
    ),
  })
  const list = await listPosts({ ...query, section })
  // Localized serving: DB cache → LibreTranslate (title-only granularity for
  // lists) → English fallback. Best-effort by design.
  const localized = await localizePostList(list.posts, locale)
  const posts = localized.map(serializePost)

  return (
    <div className="container page">
      <nav className="breadcrumb" aria-label={t('breadcrumb')}>
        <Link href="/">{t('home')}</Link>
        <span aria-hidden>/</span>
        <span style={{ color: 'var(--foreground)' }}>{meta.title}</span>
      </nav>

      <div className="page-head">
        <div className="row" style={{ gap: 16 }}>
          <span className="section-icon" style={{ width: 44, height: 44 }}>
            <Icon width={22} height={22} />
          </span>
          <div>
            <h1>{meta.title}</h1>
            <p>{ts(SECTION_DESC_KEYS[section])}</p>
          </div>
        </div>
        {section === 'blog' ? (
          <Link
            href="/profile?compose=1"
            className="chip"
            style={{ color: 'var(--link)', borderColor: 'var(--input)' }}
          >
            {tb('writePost')}
          </Link>
        ) : null}
      </div>

      <SectionFilters filters={SECTION_FILTERS[section] ?? []} />

      <PostListClient
        section={section}
        initial={{ ...list, posts }}
        emptyTitle={
          section === 'blog' ? tb('noPosts') : tb('sectionNoPosts', { section: meta.title })
        }
        emptyText={
          section === 'blog'
            ? tb('noPostsText')
            : ts('emptyFiltered')
        }
      />

      <SupportBanner />
    </div>
  )
}
