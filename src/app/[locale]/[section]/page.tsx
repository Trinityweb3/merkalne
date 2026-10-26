import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { listPosts, serializePost } from '@/lib/posts'
import { POST_SECTIONS, SECTION_META, type PostSection } from '@/lib/constants'
import { postListQuerySchema } from '@/lib/validation'
import { SectionFilters, SECTION_FILTERS } from '@/components/site/section-filters'
import { PostListClient } from '@/components/site/post-list-client'
import { SupportBanner } from '@/components/site/support-banner'
import { SECTION_ICONS } from '@/components/site/section-head'

interface PageProps {
  params: Promise<{ section: string }>
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
  const { section } = await params
  if (!isSection(section)) notFound()
  const meta = SECTION_META[section]
  const Icon = SECTION_ICONS[section]
  const t = await getTranslations('common')
  const tb = await getTranslations('blog')

  const query = postListQuerySchema.parse({
    section,
    pageSize: 9,
    ...Object.fromEntries(
      Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
    ),
  })
  const list = await listPosts({ ...query, section })
  const posts = list.posts.map(serializePost)

  return (
    <div className="container page">
      <nav className="breadcrumb" aria-label="Breadcrumb">
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
            <p>{meta.description}</p>
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
            : 'Nothing matches the selected filters. Try clearing them, or check back soon.'
        }
      />

      <SupportBanner />
    </div>
  )
}
