import { Fragment } from 'react'
import type { SerializedPost } from '@/lib/posts'
import { PostCard } from '@/components/site/post-card'
import { AdSlot } from '@/components/site/ads/ad-slot'

/**
 * Standard 3-column card grid with an honest empty state. `feedAdAfter`
 * optionally injects one in-feed ad card after the Nth post (the home page
 * uses it on its first rail); the slot renders nothing when the auction has
 * no eligible campaign.
 */
export function PostGrid({
  posts,
  homeGrid = false,
  feedAdAfter,
  emptyTitle = 'Nothing here yet',
  emptyText = 'Published material will appear in this section as soon as it is added.',
}: {
  posts: SerializedPost[]
  homeGrid?: boolean
  feedAdAfter?: number
  emptyTitle?: string
  emptyText?: string
}) {
  if (posts.length === 0) {
    return (
      <div className="empty-state card" style={{ textAlign: 'center' }}>
        <h3>{emptyTitle}</h3>
        <p className="muted small" style={{ marginTop: 8 }}>
          {emptyText}
        </p>
      </div>
    )
  }

  return (
    <div className={`grid-3 ${homeGrid ? 'home-grid' : ''}`}>
      {posts.map((post, i) => (
        <Fragment key={post.id}>
          <PostCard post={post} />
          {feedAdAfter !== undefined && i + 1 === feedAdAfter ? (
            <AdSlot slot="feed" variant="feed" />
          ) : null}
        </Fragment>
      ))}
    </div>
  )
}
