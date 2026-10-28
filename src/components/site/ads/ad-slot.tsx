'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Megaphone } from 'lucide-react'

/**
 * <AdSlot/> — one auction-powered ad placement.
 *
 * Fetches a weighted-random winner from /api/ads/serve on mount; a 204
 * (ads off, nothing eligible, rate limited) renders NOTHING — a sold-out
 * auction never leaves an empty box on the page. The rendered card is
 * deliberately distinct from real job posts: a "Sponsored" badge, a tinted
 * background and rel="sponsored" so it can never be mistaken for editorial.
 *
 * Variants (styled in globals.css):
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

export function AdSlot({
  slot,
  variant = 'feed',
}: {
  slot: string
  variant?: 'banner' | 'feed' | 'article'
}) {
  const t = useTranslations('adSlot')
  const [ad, setAd] = useState<ServedAd | null>(null)
  const clickedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/ads/serve?slot=${encodeURIComponent(slot)}`)
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
  }, [slot])

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

  return (
    <a
      className={`ad-slot ad-slot--${variant}`}
      href={ad.ctaUrl}
      target="_blank"
      rel="sponsored noopener noreferrer"
      onClick={recordClick}
      data-host={ad.ctaHost}
    >
      <span className="ad-slot-badge">
        <Megaphone width={12} height={12} aria-hidden />
        {t('sponsored')}
      </span>
      {variant === 'banner' ? (
        <span className="ad-slot-banner-body">
          <strong className="ad-slot-title">{ad.title}</strong>
          <span className="ad-slot-text">{ad.body}</span>
          <span className="ad-slot-cta">{label}</span>
        </span>
      ) : (
        <>
          <strong className="ad-slot-title">{ad.title}</strong>
          <span className="ad-slot-text">{ad.body}</span>
          <span className="ad-slot-bottom">
            <span className="ad-slot-host">{ad.ctaHost}</span>
            <span className="ad-slot-cta">{label}</span>
          </span>
        </>
      )}
    </a>
  )
}
