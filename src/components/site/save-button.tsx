'use client'

import { useRouter } from '@/i18n/navigation'
import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('save')
  const { user, bookmarkedSlugs, setBookmarked, refresh } = useSession()
  const router = useRouter()
  const saved = bookmarkedSlugs.includes(slug)

  async function toggle(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()

    if (!user) {
      toast(t('signInTitle'), {
        description: t('signInDesc'),
        action: {
          label: t('signInAction'),
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
          ? postTitle
            ? t('savedToast', { title: postTitle.slice(0, 40) + (postTitle.length > 40 ? '…' : '') })
            : t('savedPlain')
          : t('removed'),
      )
    } catch (err) {
      setBookmarked(slug, saved)
      toast.error(err instanceof Error ? err.message : t('failed'))
      void refresh()
    }
  }

  return (
    <button
      className={`icon-button ${className ?? ''}`}
      aria-label={saved ? t('removeAria') : t('saveAria')}
      aria-pressed={saved}
      title={saved ? t('removeAria') : t('saveAria')}
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
