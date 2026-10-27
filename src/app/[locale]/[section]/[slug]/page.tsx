import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Briefcase, CodeXml, Compass, ExternalLink, MapPin, Wallet } from 'lucide-react'
import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { getPostBySlug, relatedPosts, serializePost } from '@/lib/posts'
import { localizePostFull, localizePostList } from '@/lib/localize'
import { SECTION_META, type PostSection } from '@/lib/constants'
import { ArticleBody } from '@/components/site/article-body'
import { PostActions } from '@/components/site/post-actions'
import { Comments } from '@/components/site/comments'
import { SupportBanner } from '@/components/site/support-banner'
import { formatDateTime, timeAgo } from '@/lib/utils'

interface PageProps {
  params: Promise<{ locale: string; section: string; slug: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { section, slug } = await params
  const post = await getPostBySlug(slug)
  if (!post) return { title: 'Post not found' }
  return {
    title: post.title,
    description: post.body.slice(0, 150),
    ...(post.section === 'blog'
      ? { robots: { index: false, follow: true } } // Blog excluded from indexing
      : {}),
  }
}

export default async function PostDetailPage({ params }: PageProps) {
  const { locale, section, slug } = await params
  const t = await getTranslations('common')
  const fetched = await getPostBySlug(slug)
  if (!fetched || fetched.section !== section) notFound()
  // Localized serving: DB cache → LibreTranslate (title + body) → English
  // fallback. Never blocks the render beyond the client request timeout.
  const post = await localizePostFull(fetched, locale)

  const serialized = serializePost(post)
  const meta = SECTION_META[post.section as PostSection]

  const [relatedRaw, session, commentCount] = await Promise.all([
    relatedPosts(post, 3),
    getSession(),
    db.comment.count({ where: { postId: post.id } }),
  ])
  const related = await localizePostList(relatedRaw, locale)

  const reaction = session
    ? await db.reaction.findUnique({
        where: { postId_userId: { postId: post.id, userId: session.user.id } },
      })
    : null

  const metaRows = [
    post.location ? { icon: MapPin, text: post.location } : null,
    post.employment || post.level
      ? { icon: Briefcase, text: [post.employment, post.level].filter(Boolean).join(' · ') }
      : null,
    post.salary ? { icon: Wallet, text: post.salary } : null,
    post.stack ? { icon: CodeXml, text: post.stack } : null,
    post.kind && post.section === 'opportunities' ? { icon: Compass, text: post.kind } : null,
  ].filter(Boolean) as { icon: React.ComponentType<{ width?: number; height?: number }>; text: string }[]

  return (
    <div className="container page">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">{t('home')}</Link>
        <span aria-hidden>/</span>
        <Link href={`/${post.section}`}>{meta.title}</Link>
        <span aria-hidden>/</span>
        <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}>
          {post.title}
        </span>
      </nav>

      <div className="article-layout">
        <article style={{ minWidth: 0 }}>
          <h1 className="article-title">{post.title}</h1>

          <div className="article-meta">
            {post.company ? <strong>{post.company}</strong> : null}
            {post.kind ? <span className="badge">{post.kind}</span> : null}
            {post.author?.name ? <span>by {post.author.name}</span> : null}
            <span>Added {post.publishedAt ? timeAgo(post.publishedAt) : '—'}</span>
            {post.publishedAt ? <span>{formatDateTime(post.publishedAt)}</span> : null}
            <span className="badge state-published">{post.section === 'blog' ? 'Blog' : 'Editorial'}</span>
          </div>

          <ArticleBody body={post.body} />

          {post.applyUrl || post.originalUrl ? (
            <div className="button-row" style={{ marginTop: 8, marginBottom: 22 }}>
              {post.applyUrl ? (
                <a
                  href={post.applyUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="row link small"
                >
                  Apply <ExternalLink width={14} height={14} />
                </a>
              ) : null}
              {post.originalUrl ? (
                <a
                  href={post.originalUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="row link small"
                >
                  Original post <ExternalLink width={14} height={14} />
                </a>
              ) : null}
            </div>
          ) : null}

          {serialized.tags.length > 0 ? (
            <div className="tags article-tags">
              {serialized.tags.map((tag) => (
                <Link key={tag} href={`/search?q=${encodeURIComponent(`#${tag}`)}`}>
                  #{tag}
                </Link>
              ))}
            </div>
          ) : null}

          <PostActions
            slug={post.slug}
            initialViews={post.views}
            initialLikes={post.likeCount}
            initialDislikes={post.dislikeCount}
            initialReaction={
              reaction?.value === 'like' || reaction?.value === 'dislike' ? reaction.value : null
            }
          />

          <Comments slug={post.slug} initialCount={commentCount} />
        </article>

        <aside className="article-side" aria-label="About this material">
          <div className="card">
            <h3>About this material</h3>
            <p className="muted small" style={{ marginTop: 8 }}>
              Published in <Link href={`/${post.section}`} className="link">{meta.title}</Link>.
              Verify all details on the original page before acting — especially payment requests,
              downloads and wallet permissions.
            </p>
            {metaRows.length > 0 ? (
              <div className="metadata">
                {metaRows.map(({ icon: Icon, text }, i) => (
                  <div className="row" key={i}>
                    <Icon width={15} height={15} />
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {related.length > 0 ? (
            <div className="card">
              <h3>More in {meta.title}</h3>
              <div className="stack" style={{ gap: 14, marginTop: 12 }}>
                {related.map((r) => (
                  <Link
                    key={r.id}
                    href={`/${r.section}/${r.slug}`}
                    className="small"
                    style={{ display: 'block' }}
                  >
                    <strong>{r.title}</strong>
                    {r.company ? <span className="muted small"> · {r.company}</span> : null}
                    <span className="muted tiny" style={{ display: 'block' }}>
                      {r.publishedAt ? timeAgo(r.publishedAt) : ''}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      <SupportBanner />
    </div>
  )
}
