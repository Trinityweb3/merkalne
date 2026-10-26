'use client'

import { useEffect, useState } from 'react'
import { Link } from '@/i18n/navigation'
import { useRouter } from '@/i18n/navigation'
import { toast } from 'sonner'
import { MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useSession } from '@/components/providers/session-provider'
import { api } from '@/lib/api-client'
import { timeAgo } from '@/lib/utils'

interface CommentItem {
  id: string
  body: string
  createdAt: string
  user: { id: string; name: string | null; image: string | null }
}

/** Comment area — reading is public, writing requires a registered account. */
export function Comments({ slug, initialCount }: { slug: string; initialCount: number }) {
  const { user } = useSession()
  const router = useRouter()
  const [comments, setComments] = useState<CommentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    api<{ comments: CommentItem[] }>(`/api/posts/${encodeURIComponent(slug)}/comments`)
      .then((d) => {
        if (!cancelled) setComments(d.comments)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!user) {
      toast('Sign in to join the discussion', {
        action: { label: 'Sign in', onClick: () => router.push('/auth?mode=login') },
      })
      return
    }
    if (!body.trim()) return
    setSubmitting(true)
    try {
      const result = await api<{ comment: CommentItem }>(`/api/posts/${encodeURIComponent(slug)}/comments`, {
        method: 'POST',
        body: { body },
      })
      setComments((prev) => [result.comment, ...prev])
      setBody('')
      toast.success('Comment posted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not post the comment')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="comments" id="comments" aria-label="Comments">
      <div className="row between wrap" style={{ marginBottom: 8 }}>
        <h2 style={{ fontSize: '1.35rem' }}>
          Comments <span className="muted small">({comments.length || initialCount})</span>
        </h2>
        <span className="muted small">Be respectful. Comments are moderated.</span>
      </div>

      <form onSubmit={submit} className="card" style={{ marginBottom: 22 }}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
          <Avatar className="mt-1">
            {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
            <AvatarFallback>{user ? (user.name || user.email).slice(0, 2).toUpperCase() : <MessageCircle width={16} height={16} />}</AvatarFallback>
          </Avatar>
          <div className="stack" style={{ gap: 10, flex: 1, minWidth: 0 }}>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={user ? 'Share your thoughts…' : 'Sign in to write a comment'}
              rows={3}
              maxLength={4000}
              disabled={!user}
              aria-label="Write a comment"
            />
            <div className="row between">
              <small className="muted">{body.length}/4000</small>
              <Button type="submit" size="sm" disabled={!user || submitting || !body.trim()}>
                {submitting ? 'Posting…' : 'Post comment'}
              </Button>
            </div>
            {!user ? (
              <small className="muted">
                <Link href="/auth?mode=login" className="link">
                  Sign in
                </Link>{' '}
                — registration is free and takes a minute.
              </small>
            ) : null}
          </div>
        </div>
      </form>

      {loading ? (
        <div className="muted small">Loading comments…</div>
      ) : comments.length === 0 ? (
        <div className="empty-state card muted">No comments yet. Be the first to share your view.</div>
      ) : (
        comments.map((comment) => (
          <div className="comment" key={comment.id}>
            <div className="row" style={{ gap: 12 }}>
              <Avatar className="!size-9">
                {comment.user.image ? <AvatarImage src={comment.user.image} alt="" /> : null}
                <AvatarFallback className="text-xs">
                  {(comment.user.name || '?').slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div style={{ minWidth: 0 }}>
                <strong className="small">{comment.user.name || 'Member'}</strong>
                <span className="muted tiny" style={{ marginLeft: 8 }}>
                  {timeAgo(comment.createdAt)}
                </span>
                <p className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {comment.body}
                </p>
              </div>
            </div>
          </div>
        ))
      )}
    </section>
  )
}
