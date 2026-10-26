'use client'

import { useRouter } from '@/i18n/navigation'
import { Link } from '@/i18n/navigation'
import { Bookmark } from 'lucide-react'
import { toast } from 'sonner'
import { useSession } from '@/components/providers/session-provider'
import { api } from '@/lib/api-client'

interface SaveButtonProps {
  slug: string
  postTitle?: string
  size?: number
  className?: string
}

/**
 * Bookmark (save) button. Guests are prompted to register — bookmarks are
 * free for every registered user and sync across devices.
 */
export function SaveButton({ slug, postTitle, size = 18, className }: SaveButtonProps) {
  const { user, bookmarkedSlugs, setBookmarked, refresh } = useSession()
  const router = useRouter()
  const saved = bookmarkedSlugs.includes(slug)

  async function toggle(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()

    if (!user) {
      toast('Sign in to save posts', {
        description: 'Bookmarks are free for registered users and sync across your devices.',
        action: {
          label: 'Sign in',
          onClick: () => router.push('/auth?mode=login'),
        },
      })
      return
    }

    // Optimistic update; rollback on failure.
    setBookmarked(slug, !saved)
    try {
      const result = await api<{ bookmarked: boolean }>(`/api/posts/${encodeURIComponent(slug)}/bookmark`, {
        method: 'POST',
      })
      setBookmarked(slug, result.bookmarked)
      toast.success(
        result.bookmarked
          ? `Saved${postTitle ? ` “${postTitle.slice(0, 40)}${postTitle.length > 40 ? '…' : ''}”` : ''}`
          : 'Removed from saved',
      )
    } catch (err) {
      setBookmarked(slug, saved)
      toast.error(err instanceof Error ? err.message : 'Could not save the post')
      void refresh()
    }
  }

  return (
    <button
      className={`icon-button ${className ?? ''}`}
      aria-label={saved ? 'Remove from saved' : 'Save post'}
      aria-pressed={saved}
      title={saved ? 'Remove from saved' : 'Save post'}
      onClick={toggle}
      type="button"
    >
      <Bookmark
        width={size}
        height={size}
        style={saved ? { color: 'var(--link)', fill: 'var(--link)' } : undefined}
      />
    </button>
  )
}
