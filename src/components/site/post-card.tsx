import { Link } from '@/i18n/navigation'
import { Briefcase, CodeXml, Compass, MapPin, Wallet } from 'lucide-react'
import type { SerializedPost } from '@/lib/posts'
import { formatDate, initials, snippet, timeAgo } from '@/lib/utils'
import { SaveButton } from '@/components/site/save-button'

/**
 * Mosaic post card — exact replica of the reference card anatomy:
 * brand square + kind, bookmark, title/company, metadata rows, snippet,
 * footer (added-ago + date), hashtag links.
 */
export function PostCard({ post, compact }: { post: SerializedPost; compact?: boolean }) {
  const href = `/${post.section}/${post.slug}`
  const brand = post.company ?? post.title
  const meta = [
    post.location
      ? { icon: MapPin, text: post.location }
      : null,
    post.employment || post.level
      ? { icon: Briefcase, text: [post.employment, post.level].filter(Boolean).join(' · ') }
      : null,
    post.salary
      ? { icon: Wallet, text: post.salary }
      : null,
    post.stack
      ? { icon: CodeXml, text: post.stack }
      : null,
    !post.employment && !post.location && post.kind && post.section === 'opportunities'
      ? { icon: Compass, text: post.kind }
      : null,
  ].filter(Boolean) as { icon: React.ComponentType<{ width?: number; height?: number }>; text: string }[]

  return (
    <article className="card post-card">
      <div className="card-top">
        <div className="row">
          <span className="brand-square">{initials(brand)}</span>
          <div>
            <div className="card-kind">{post.kind ?? 'Post'}</div>
          </div>
        </div>
        <SaveButton slug={post.slug} postTitle={post.title} />
      </div>

      <Link href={href} className="block">
        <h3>{post.title}</h3>
        {post.company ? <p className="company">{post.company}</p> : null}
      </Link>

      {meta.length > 0 ? (
        <div className="metadata">
          {meta.map(({ icon: Icon, text }, i) => (
            <div className="row" key={i}>
              <Icon width={15} height={15} />
              <span>{text}</span>
            </div>
          ))}
        </div>
      ) : null}

      {!compact && post.section !== 'intern-junior' && post.section !== 'mid-senior' ? (
        <Link href={href} className="card-snippet">
          {/* post.snippet = the machine-translated excerpt on localized
              routes (filled by localizePostList); English falls back to the
              plain-text excerpt of the body. */}
          {post.snippet ?? snippet(post.body)}
        </Link>
      ) : null}

      <div className="card-bottom">
        <span>Added {post.publishedAt ? timeAgo(post.publishedAt) : '—'}</span>
        <span>{formatDate(post.publishedAt) ?? 'Draft'}</span>
      </div>

      {post.tags.length > 0 ? (
        <div className="tags" style={{ marginTop: 13 }}>
          {post.tags.map((tag) => (
            <Link key={tag} href={`/search?q=${encodeURIComponent(`#${tag}`)}`}>
              #{tag}
            </Link>
          ))}
        </div>
      ) : null}
    </article>
  )
}
