'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { usePathname } from '@/i18n/navigation'
import { useSearchParams } from 'next/navigation'
import { PostCard } from '@/components/site/post-card'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api-client'
import type { SerializedPost } from '@/lib/posts'

interface ListResponse {
  posts: SerializedPost[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/**
 * Section listing with progressive "Load more" pagination. The first page is
 * server-rendered (SEO + instant paint); subsequent pages append client-side
 * from /api/posts with the same URL filters.
 */
export function PostListClient({
  section,
  initial,
  emptyTitle,
  emptyText,
}: {
  section: string
  initial: ListResponse
  emptyTitle?: string
  emptyText?: string
}) {
  const t = useTranslations('postList')
  const tc = useTranslations('common')
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const [posts, setPosts] = useState(initial.posts)
  const [page, setPage] = useState(initial.page)
  const [totalPages, setTotalPages] = useState(initial.totalPages)
  const [total, setTotal] = useState(initial.total)
  const [loading, setLoading] = useState(false)
  const topRef = useRef<HTMLDivElement | null>(null)
  const lastQuery = searchParams.toString()

  // When filters change (URL), reset to the freshly rendered first page.
  useEffect(() => {
    setPosts(initial.posts)
    setPage(initial.page)
    setTotalPages(initial.totalPages)
    setTotal(initial.total)
  }, [initial, lastQuery])

  const loadMore = useCallback(async () => {
    if (loading || page >= totalPages) return
    setLoading(true)
    try {
      const params = new URLSearchParams(searchParams.toString())
      params.set('section', section)
      params.set('page', String(page + 1))
      params.set('pageSize', '9')
      const data = await api<ListResponse>(`/api/posts?${params.toString()}`)
      // Deduplicate by id (protects against shifts between pages).
      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id))
        return [...prev, ...data.posts.filter((p) => !seen.has(p.id))]
      })
      setPage(data.page)
      setTotalPages(data.totalPages)
      setTotal(data.total)
    } catch {
      // surfaced via button state; safe to retry
    } finally {
      setLoading(false)
    }
  }, [loading, page, totalPages, searchParams, section])

  if (posts.length === 0) {
    return (
      <div className="empty-state card" style={{ textAlign: 'center' }}>
        <h3>{emptyTitle ?? t('emptyTitle')}</h3>
        <p className="muted small" style={{ marginTop: 8 }}>
          {emptyText ?? t('emptyText')}
        </p>
      </div>
    )
  }

  return (
    <div ref={topRef}>
      <p className="muted small" style={{ marginBottom: 16 }} aria-live="polite">
        {t('count', { count: total })}
      </p>
      <div className="grid-3">
        {posts.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>

      {page < totalPages ? (
        <div className="row wrap" style={{ marginTop: 22, justifyContent: 'center' }}>
          <Button variant="outline" onClick={loadMore} disabled={loading}>
            {loading ? tc('loading') : t('loadMore', { remaining: total - posts.length })}
          </Button>
        </div>
      ) : (
        <p className="muted small" style={{ marginTop: 22, textAlign: 'center' }}>
          {t('end')}{' '}
          <a
            href="#"
            className="link"
            onClick={(e) => {
              e.preventDefault()
              topRef.current?.scrollIntoView({ behavior: 'smooth' })
            }}
          >
            {t('backToTop')}
          </a>
        </p>
      )}
    </div>
  )
}
