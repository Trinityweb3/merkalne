'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Megaphone } from 'lucide-react'

/**
 * <AdSlot/> — one auction-powered ad placement.
 *
 * Fetches a winner from /api/ads/serve on mount (50/50 CPC/CPM pool split,
 * weighted-random inside the pool), passing the TARGETING CONTEXT: the
 * active interface locale (always), the content section (via the
 * `section` prop) and the page's keyword/hashtag context (via `keywords` /
 * `hashtags`; article pages pass the post title + tags). Campaigns whose
 * targeting excludes this context never enter the draw. A 204 (ads off,
 * nothing eligible, rate limited) renders NOTHING — a sold-out auction
 * never leaves an empty box on the page.
 *
 * FORMAT (independent of billing):
 *   text   → headline + body + display domain + CTA button
 *   banner → the advertiser's uploaded image, edge to edge (alt text from
 *            the creative)
 *
 * The rendered card is deliberately distinct from real job posts: a
 * "Sponsored" badge, a gold tinted border and rel="sponsored" so it can
 * never be mistaken for editorial.
 *
 * ── Phase 3 event pipeline ────────────────────────────────────────────
 *
 * CLICKS: the card's href no longer opens the destination directly — it
 * goes through the SECURE REDIRECT ROUTE /api/ads/click/[token], carrying
 * the serve's HMAC token. That route validates the signature, logs the
 * valid_click event, charges the CPC campaign (a held BudgetReservation
 * is finalised — the only CPC billing event) and 302-redirects to the
 * advertiser's https destination. CPM clicks are logged but never charged
 * (CPM bills views); duplicate clicks are settled server-side to a single
 * charge, so no client-side dedup state is needed here.
 *
 * VIEWABILITY: this component measures when the ad becomes VIEWABLE —
 * at least 50 % of its area inside the viewport (IntersectionObserver) for
 * ONE CONTINUOUS second (a local timer) while the tab is ACTIVE (Page
 * Visibility API). Only then does it beacon POST /api/ads/event with the
 * same signed token; the server re-verifies the HMAC and, for a CPM
 * campaign, finalises the held reservation — the only CPM billing event.
 * Interruptions (scrolled below 50 %, tab hidden) reset the continuous
 * second; the beacon fires at most once per served ad.
 */

/** Viewability spec: ≥ 50 % of the ad visible … */
const VIEWABLE_RATIO = 0.5
/** … for one continuous second (ms), in an active tab. */
const VIEWABLE_MS = 1000

interface ServedAd {
  campaignId: string
  reservationId: string
  /** HMAC token — authenticates the click redirect and the viewability beacon. */
  clickToken: string
  format: 'text' | 'banner'
  billingModel: 'cpc' | 'cpm'
  title: string | null
  body: string | null
  imageUrl: string | null
  altText: string | null
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
  keywords,
  hashtags,
}: {
  slot: string
  variant?: 'banner' | 'feed' | 'article'
  /** Content section slug ("intern-junior", …) or "home" — targeting context. */
  section?: string
  /** Page keyword context (article pages: post title + tags). */
  keywords?: string[]
  /** Page hashtags (article pages: post tags). */
  hashtags?: string[]
}) {
  const t = useTranslations('adSlot')
  const locale = useLocale()
  const [ad, setAd] = useState<ServedAd | null>(null)

  /** The rendered card — the viewability measurement target. */
  const cardRef = useRef<HTMLAnchorElement | null>(null)

  useEffect(() => {
    let cancelled = false
    const qs = new URLSearchParams({ slot, locale })
    if (section) qs.set('section', section)
    const kw = keywords && keywords.length > 0 ? keywords.join(',') : ''
    const tags = hashtags && hashtags.length > 0 ? hashtags.join(',') : ''
    if (kw) qs.set('keywords', kw)
    if (tags) qs.set('hashtags', tags)
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
    // String deps: array props would be a fresh reference per parent render
    // and re-trigger the auction fetch (and its budget holds) forever.
  }, [slot, locale, section, keywords?.join(','), hashtags?.join(',')])

  // ── Viewability: ≥ 50 % visible for one continuous second, active tab ──
  useEffect(() => {
    if (!ad || !ad.clickToken) return
    const el = cardRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return

    // Effect-local state — the measurement lives exactly as long as this
    // ad is mounted. `ratio` is the share of the card inside the viewport.
    let ratio = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let fired = false

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    // The one-shot beacon. keepalive so it survives the visitor navigating
    // away in the same instant (the same trick the old click beacon used).
    const fire = () => {
      if (fired) return
      fired = true
      clearTimer()
      fetch('/api/ads/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ad.clickToken, type: 'viewable_impression' }),
        keepalive: true,
      }).catch(() => undefined)
    }

    // Start the continuous second only when BOTH conditions hold; any
    // interruption (scrolled under 50 %, tab hidden) cancels and resets.
    const evaluate = () => {
      if (fired) return
      const tabActive = document.visibilityState === 'visible'
      if (ratio >= VIEWABLE_RATIO && tabActive) {
        if (timer === null) timer = setTimeout(fire, VIEWABLE_MS)
      } else {
        clearTimer()
      }
    }

    const onVisibilityChange = () => evaluate()

    const observer = new IntersectionObserver(
      (entries) => {
        // The last entry carries the current intersection ratio.
        ratio = entries[entries.length - 1]?.intersectionRatio ?? 0
        evaluate()
      },
      // Extra thresholds around the 0.5 boundary so the callback fires
      // promptly when the card crosses half-visible from either side.
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    )
    observer.observe(el)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearTimer()
    }
    // `ad` is a stable object identity per serve (setAd once per fetch).
  }, [ad])

  if (!ad) return null

  // The click goes through the signed redirect route; the honest https
  // destination is only ever read by the server from the signed token.
  const clickHref = ad.clickToken
    ? `/api/ads/click/${encodeURIComponent(ad.clickToken)}`
    : ad.targetUrl

  if (ad.format === 'banner' && ad.imageUrl) {
    return (
      <a
        ref={cardRef}
        className={`${SLOT_BASE} ${BANNER_VARIANTS[variant]}`}
        href={clickHref}
        target="_blank"
        rel="sponsored noopener noreferrer"
        data-host={ad.targetHost}
      >
        <span className="absolute -top-2.5 start-3.5 z-[1] inline-flex items-center gap-1.5 rounded-md border border-chart-4/40 bg-card px-2 py-0.5 text-[0.66rem] font-bold uppercase tracking-[0.08em] text-chart-4">
          <Megaphone width={12} height={12} aria-hidden />
          {t('sponsored')}
        </span>
        {/* Banner creative — the image IS the ad. Alt text comes from the
            creative (accessibility), falling back to the display domain. */}
        <img
          src={ad.imageUrl}
          alt={ad.altText || ad.targetHost}
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
      ref={cardRef}
      className={`${SLOT_BASE} ${TEXT_VARIANTS[variant]}`}
      href={clickHref}
      target="_blank"
      rel="sponsored noopener noreferrer"
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
