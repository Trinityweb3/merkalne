'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Megaphone } from 'lucide-react'

/**
 * <AdSlot/> — one auction-powered ad placement.
 *
 * Fetches a weighted-random winner from /api/ads/serve on mount, passing
 * the TARGETING CONTEXT: the active interface locale (always) and the
 * content section (via the `section` prop — "intern-junior", "home", …).
 * Campaigns whose targeting excludes this context never enter the draw.
 * A 204 (ads off, nothing eligible, rate limited) renders NOTHING — a
 * sold-out auction never leaves an empty box on the page. The rendered
 * card is deliberately distinct from real job posts: a "Sponsored" badge,
 * a gold tinted border and rel="sponsored" so it can never be mistaken for
 * editorial.
 *
 * Variants (standard Tailwind utilities, legacy design language — rounded
 * bordered bg-card blocks, no dependency on custom globals.css classes):
 *   banner  — compact strip below the hero
 *   feed    — card that slots into the post grid
 *   article — card at the bottom of a post, above the comments
 */

interface ServedAd {
  campaignId: string
  impressionId: string
  title: string
  body: string
  ctaUrl: string
  ctaLabel: string | null
  ctaHost: string
  bidPerView: number
}

/**
 * Placement chrome, kept in the legacy template's visual language: rounded,
 * bordered bg-card blocks. The gold (chart-4) tinted border + "Sponsored"
 * badge are what keep the slot visually distinct from editorial post cards.
 */
const SLOT_BASE =
  'relative flex min-w-0 gap-2 rounded-xl border border-chart-4/25 bg-card transition-colors hover:border-chart-4/60'

const SLOT_VARIANTS = {
  /** Compact strip below the hero. */
  banner: 'mb-11 flex-row items-center px-4 py-3',
  /** Card that slots into the post grid. */
  feed: 'mt-2.5 min-h-80 flex-col p-[18px] pb-4',
  /** Card at the bottom of a post, above the comments. */
  article: 'mt-6 flex-col p-[18px] pb-4',
} as const

export function AdSlot({
  slot,
  variant = 'feed',
  section,
}: {
  slot: string
  variant?: 'banner' | 'feed' | 'article'
  /** Content section slug ("intern-junior", …) or "home" — targeting context. */
  section?: string
}) {
  const t = useTranslations('adSlot')
  const locale = useLocale()
  const [ad, setAd] = useState<ServedAd | null>(null)
  const clickedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const qs = new URLSearchParams({ slot, locale })
    if (section) qs.set('section', section)
    fetch(`/api/ads/serve?${qs.toString()}`)
      .then(async (res) => {
        if (!res.ok) return null // 204 or error → no ad
        // Unwrap the { ok, data } envelope the API always answers with.
        const body = (await res.json().catch(() => null)) as
          | { data?: { ad?: ServedAd | null } }
          | null
        return body?.data?.ad ?? null
      })
      .then((served) => {
        if (!cancelled) setAd(served)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [slot, locale, section])

  if (!ad) return null

  function recordClick() {
    if (!ad || clickedRef.current) return
    const impressionId = ad.impressionId
    clickedRef.current = true
    fetch('/api/ads/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ impressionId }),
      keepalive: true,
    }).catch(() => undefined)
  }

  const label = ad.ctaLabel?.trim() || t('cta')
  const isBanner = variant === 'banner'

  return (
    <a
      className={`${SLOT_BASE} ${SLOT_VARIANTS[variant]}`}
      href={ad.ctaUrl}
      target="_blank"
      rel="sponsored noopener noreferrer"
      onClick={recordClick}
      data-host={ad.ctaHost}
    >
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border border-chart-4/40 bg-card px-2 py-0.5 text-[0.66rem] font-bold uppercase tracking-[0.08em] text-chart-4 ${
          isBanner ? 'me-1 shrink-0' : 'absolute -top-2.5 start-3.5'
        }`}
      >
        <Megaphone width={12} height={12} aria-hidden />
        {t('sponsored')}
      </span>
      {isBanner ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <strong className="text-[0.98rem] font-semibold leading-snug tracking-tight">{ad.title}</strong>
          <span className="line-clamp-1 basis-60 grow text-sm leading-relaxed text-muted-foreground">{ad.body}</span>
          <span className="ms-auto whitespace-nowrap text-sm font-semibold text-link">{label}</span>
        </span>
      ) : (
        <>
          <strong className="text-[1.05rem] font-semibold leading-snug tracking-tight">{ad.title}</strong>
          <span className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{ad.body}</span>
          <span className="mt-auto flex items-center justify-between gap-3 pt-3">
            <span className="truncate text-xs text-muted-foreground">{ad.ctaHost}</span>
            <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-link">{label}</span>
          </span>
        </>
      )}
    </a>
  )
}
