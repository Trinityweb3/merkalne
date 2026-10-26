'use client'

import { useEffect, useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { toast } from 'sonner'
import { Eye, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useSession } from '@/components/providers/session-provider'
import { ReportDialog } from '@/components/site/report-dialog'
import { api } from '@/lib/api-client'

/**
 * Post action row — views (from the shared counter), like / dislike (one
 * active reaction per account; grey when unset, green like / red dislike),
 * and the report control. Fire-and-forget view beacon fires once per mount.
 */
export function PostActions({
  slug,
  initialViews,
  initialLikes,
  initialDislikes,
  initialReaction,
}: {
  slug: string
  initialViews: number
  initialLikes: number
  initialDislikes: number
  initialReaction: 'like' | 'dislike' | null
}) {
  const { user } = useSession()
  const router = useRouter()
  const [views, setViews] = useState(initialViews)
  const [likes, setLikes] = useState(initialLikes)
  const [dislikes, setDislikes] = useState(initialDislikes)
  const [reaction, setReaction] = useState<'like' | 'dislike' | null>(initialReaction)
  const [busy, setBusy] = useState(false)

  // View de-dup happens server side (cookie + rate limit).
  useEffect(() => {
    let cancelled = false
    api<{ counted: boolean }>(`/api/posts/${encodeURIComponent(slug)}/view`, { method: 'POST' })
      .then((r) => {
        if (!cancelled && r.counted) setViews((v) => v + 1)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [slug])

  async function react(value: 'like' | 'dislike') {
    if (!user) {
      toast('Sign in to react', {
        description: 'One reaction per account keeps the signal honest.',
        action: { label: 'Sign in', onClick: () => router.push('/auth?mode=login') },
      })
      return
    }
    if (busy) return
    setBusy(true)

    // Desired end-state: toggling the active reaction clears it.
    const desired = reaction === value ? 'none' : value

    // Optimistic UI.
    const prev = { reaction, likes, dislikes }
    if (desired === 'none') {
      if (value === 'like') setLikes((n) => n - 1)
      else setDislikes((n) => n - 1)
      setReaction(null)
    } else if (desired === 'like') {
      setLikes((n) => n + 1)
      if (prev.reaction === 'dislike') setDislikes((n) => n - 1)
      setReaction('like')
    } else {
      setDislikes((n) => n + 1)
      if (prev.reaction === 'like') setLikes((n) => n - 1)
      setReaction('dislike')
    }

    try {
      const result = await api<{ yourReaction: string | null; likeCount: number; dislikeCount: number }>(
        `/api/posts/${encodeURIComponent(slug)}/reaction`,
        { method: 'POST', body: { value: desired } },
      )
      setLikes(result.likeCount)
      setDislikes(result.dislikeCount)
      setReaction(result.yourReaction === 'like' || result.yourReaction === 'dislike' ? result.yourReaction : null)
    } catch (err) {
      setReaction(prev.reaction)
      setLikes(prev.likes)
      setDislikes(prev.dislikes)
      toast.error(err instanceof Error ? err.message : 'Could not save your reaction')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="post-actions">
      <span className="post-views" aria-label={`${views} views`}>
        <Eye width={18} height={18} />
        <span className="post-action-count">{views.toLocaleString()}</span>
      </span>
      <button
        type="button"
        className={`post-action ${reaction === 'like' ? 'is-liked' : ''}`}
        aria-pressed={reaction === 'like'}
        aria-label="Like"
        onClick={() => react('like')}
      >
        <ThumbsUp width={18} height={18} />
        <span className="post-action-count post-action-label">{likes.toLocaleString()}</span>
      </button>
      <button
        type="button"
        className={`post-action ${reaction === 'dislike' ? 'is-disliked' : ''}`}
        aria-pressed={reaction === 'dislike'}
        aria-label="Dislike"
        onClick={() => react('dislike')}
      >
        <ThumbsDown width={18} height={18} />
        <span className="post-action-count post-action-label">{dislikes.toLocaleString()}</span>
      </button>
      <ReportDialog slug={slug} />
    </div>
  )
}
