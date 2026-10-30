'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Megaphone } from 'lucide-react'

/**
 * <AdSlot/> — one auction-powered ad placement.
 *
 * Fetches a winner from /api/ads/serve on mount (50/50 CPC/CPM pool split,
 * weighted-random inside the pool), passing the TARGETING CONTEXT: the
 * active interface locale (always) and the content section (via the
 * `section` prop). Campaigns whose targeting excludes this context never
 * enter the draw. A 204 (ads off, nothing eligible, rate limited) renders
 * NOTHING — a sold-out auction never leaves an empty box on the page.
 *
 * FORMAT (independent of billing):
 *   text   → headline + body + destination host + CTA button
 *   banner → the advertiser's image, edge to edge
 *
 * The rendered card is deliberately distinct from real job posts: a
 * "Sponsored" badge, a gold tinted border and rel="sponsored" so it can
 * never be mistaken for editorial.
 *
 * The click beacon echoes the reservationId — for a CPC campaign it
 * finalises the held budget reservation (the only billing event); CPM
 * campaigns were charged at serve time, so their beacon is a no-op.
 */

interface ServedAd {
  campaignId: string
  reservationId: string
  format: 'text' | 'banner'
  billingModel: 'cpc' | 'cpm'
  title: string | null
  body: string | null
  imageUrl: string | null
  targetUrl: string
  targetHost: string
  bidMicroUsd: number
}

/**
 * Placement chrome, kept in the legacy template's visual language: rounded,
 * bordered bg-card blocks. The gold (chart-4) tinted border + "Sponsored"
 * badge are what keep the slot visually distinct from editorial post cards.
 */
const SLOT_BASE =
  'relative flex min-w-0 rounded-xl border border-chart-4/25 bg-card transition-colors hover:border-chart-4/60'

/** Text creatives: the classic card shapes (strip below hero / grid card / article card). */
const TEXT_VARIANTS = {
  banner: 'mb-11 flex-row items-center gap-2 px-4 py-3',
  feed: 'mt-2.5 min-h-80 flex-col gap-2 p-[18px] pb-4',
  article: 'mt-6 flex-col gap-2 p-[18px] pb-4',
} as const

/** Banner creatives: the image runs edge to edge — no padding. */
const BANNER_VARIANTS = {
  banner: 'mb-11 block overflow-hidden',
  feed: 'mt-2.5 block overflow-hidden',
  article: 'mt-6 block overflow-hidden',
} as const

/** Image aspect per placement: a wide strip under the hero, a taller card in grids. */
const BANNER_ASPECT = {
  banner: 'aspect-[6/1]',
  feed: 'aspect-[5/2]',
  article: 'aspect-[5/2]',
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
    const reservationId = ad.reservationId
    clickedRef.current = true
    fetch('/api/ads/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservationId }),
      keepalive: true,
    }).catch(() => undefined)
  }

  if (ad.format === 'banner' && ad.imageUrl) {
    return (
      <a
        className={`${SLOT_BASE} ${BANNER_VARIANTS[variant]}`}
        href={ad.targetUrl}
        target="_blank"
        rel="sponsored noopener noreferrer"
        onClick={recordClick}
        data-host={ad.targetHost}
      >
        <span className="absolute -top-2.5 start-3.5 z-[1] inline-flex items-center gap-1.5 rounded-md border border-chart-4/40 bg-card px-2 py-0.5 text-[0.66rem] font-bold uppercase tracking-[0.08em] text-chart-4">
          <Megaphone width={12} height={12} aria-hidden />
          {t('sponsored')}
        </span>
        {/* Banner creative — the image IS the ad. */}
        <img
          src={ad.imageUrl}
          alt={ad.targetHost}
          className={`w-full object-cover ${BANNER_ASPECT[variant]}`}
          loading="lazy"
        />
      </a>
    )
  }

  // Text creative — the classic card.
  const label = t('cta')
  const isStrip = variant === 'banner'
  return (
    <a
      className={`${SLOT_BASE} ${TEXT_VARIANTS[variant]}`}
      href={ad.targetUrl}
      target="_blank"
      rel="sponsored noopener noreferrer"
      onClick={recordClick}
      data-host={ad.targetHost}
    >
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border border-chart-4/40 bg-card px-2 py-0.5 text-[0.66rem] font-bold uppercase tracking-[0.08em] text-chart-4 ${
          isStrip ? 'me-1 shrink-0' : 'absolute -top-2.5 start-3.5'
        }`}
      >
        <Megaphone width={12} height={12} aria-hidden />
        {t('sponsored')}
      </span>
      {isStrip ? (
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
            <span className="truncate text-xs text-muted-foreground">{ad.targetHost}</span>
            <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-link">{label}</span>
          </span>
        </>
      )}
    </a>
  )
}
