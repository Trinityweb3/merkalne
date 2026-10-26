import type { SerializedPost } from '@/lib/posts'
import { PostCard } from '@/components/site/post-card'

/** Standard 3-column card grid with an honest empty state. */
export function PostGrid({
  posts,
  homeGrid = false,
  emptyTitle = 'Nothing here yet',
  emptyText = 'Published material will appear in this section as soon as it is added.',
}: {
  posts: SerializedPost[]
  homeGrid?: boolean
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
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
    </div>
  )
}
