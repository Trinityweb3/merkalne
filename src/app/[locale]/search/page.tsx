import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { env } from '@/lib/env'
import { SECTION_META } from '@/lib/constants'
import { searchQuerySchema } from '@/lib/validation'
import { serializePost } from '@/lib/posts'
import { SearchBox } from '@/components/site/search-box'
import { Pagination } from '@/components/site/pagination'
import { SupportBanner } from '@/components/site/support-banner'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search jobs, opportunities, market signals and insights across Merklane.',
}

interface SearchPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** Build a snippet around the first term match, highlighting all terms. */
function highlight(text: string, terms: string[]): React.ReactNode {
  if (terms.length === 0) return text
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  // split() with a capturing group puts matches at odd indices.
  const parts = text.split(re)
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))
}

function snippetAround(body: string, terms: string[], radius = 130): string {
  if (terms.length === 0) return body.slice(0, radius * 2)
  const lower = body.toLowerCase()
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase())
    if (idx >= 0) {
      const start = Math.max(0, idx - radius)
      const end = Math.min(body.length, idx + term.length + radius)
      return `${start > 0 ? '… ' : ''}${body.slice(start, end)}${end < body.length ? ' …' : ''}`
    }
  }
  return body.slice(0, radius * 2)
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const raw = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  )
  const parsed = searchQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : { q: '', page: 1 }
  const { q, page } = query
  const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 8)
  // For highlighting/snippets a hashtag matches with or without the hash.
  const highlightTerms = terms.map((t) => (t.startsWith('#') ? t.slice(1) : t)).filter(Boolean)

  const where: Prisma.PostWhereInput = {
    status: 'published',
    section: { not: 'blog' }, // Blog is excluded from Merklane search by design
  }

  if (terms.length > 0) {
    const insensitive = (field: string, value: string): Record<string, unknown> =>
      env.DATABASE_PROVIDER === 'sqlite'
        ? { [field]: { contains: value } }
        : { [field]: { contains: value, mode: 'insensitive' as const } }

    // Hashtag queries (#tag) use exact tag matching: "#Front" must never
    // match "#Frontend". Tags are stored normalised ("a,b") so the match is
    // delimiter-bounded.
    const tagTerm = terms.find((t) => t.startsWith('#') && t.length > 1)
    const textTerms = terms.filter((t) => t !== tagTerm)

    const termFilters: Prisma.PostWhereInput[] = textTerms.map((term) => ({
      OR: [
        insensitive('title', term),
        insensitive('body', term),
        insensitive('company', term),
        insensitive('stack', term),
        insensitive('tags', term),
      ],
    }))

    if (tagTerm) {
      const tag = tagTerm.slice(1).toLowerCase()
      termFilters.push({
        OR: [
          { tags: tag },
          { tags: { startsWith: `${tag},` } },
          { tags: { contains: `,${tag},` } },
          { tags: { endsWith: `,${tag}` } },
        ],
      })
    }

    where.AND = termFilters
  }

  const pageSize = 10
  const [total, results] = await Promise.all([
    db.post.count({ where }),
    db.post.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        slug: true,
        section: true,
        kind: true,
        title: true,
        company: true,
        body: true,
        tags: true,
        publishedAt: true,
      },
    }),
  ])

  const t = await getTranslations('search')
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const makeHref = (p: number) =>
    `?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) }).toString()}`

  return (
    <div className="container page">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>{t('title')}</h1>
          <p>{t('pageSub')}</p>
        </div>
      </div>

      <SearchBox initialValue={q} autoFocus={false} />

      <div className="search-tabs" role="tablist" aria-label={t('sections')}>
        <Link href="/search" className={!raw.section ? 'active' : ''}>
          {t('allResults')}
        </Link>
        {(['intern-junior', 'mid-senior', 'opportunities', 'markets', 'insights'] as const).map(
          (section) => (
            <Link
              key={section}
              href={`/search?${new URLSearchParams({ ...(q ? { q } : {}), section }).toString()}`}
              className={raw.section === section ? 'active' : ''}
            >
              {SECTION_META[section].title}
            </Link>
          ),
        )}
      </div>

      <div className="search-content">
        <p className="muted small" style={{ marginTop: 18 }} aria-live="polite">
          {terms.length === 0
            ? t('browsingAll', { count: total })
            : t('resultsFor', { count: total, query: q })}
        </p>

        {results.length === 0 ? (
          <div className="empty-state card" style={{ marginTop: 20 }}>
            <h3>{t('noResults')}</h3>
            <p className="muted small" style={{ marginTop: 8 }}>
              {terms.length === 0 ? t('nothingYet') : t('noResultsHint')}
            </p>
          </div>
        ) : (
          results.map((post) => {
            const serialized = serializePost(post as never)
            return (
              <div className="result" key={post.id}>
                <div className="result-path">
                  merklane.com/{post.section} {post.company ? `· ${post.company}` : ''}
                  {post.kind ? ` · ${post.kind}` : ''} ·{' '}
                  {post.publishedAt ? formatDateTime(post.publishedAt) : ''}
                </div>
                <h3>
                  <Link href={`/${post.section}/${post.slug}`}>{highlight(post.title, highlightTerms)}</Link>
                </h3>
                <p>{highlight(snippetAround(post.body, highlightTerms), highlightTerms)}</p>
                {serialized.tags.length > 0 ? (
                  <div className="tags">
                    {serialized.tags.slice(0, 5).map((tag) => (
                      <Link key={tag} href={`/search?q=${encodeURIComponent(`#${tag}`)}`}>
                        #{tag}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })
        )}

        <Pagination page={page} totalPages={totalPages} makeHref={makeHref} />
      </div>

      <SupportBanner />
    </div>
  )
}
