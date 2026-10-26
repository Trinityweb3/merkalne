'use client'

/**
 * Anonymous page-view beacon for the About-page statistics.
 *
 * Fires once per route change (and once per first load) at POST /api/track:
 *   * client-side dedupe — the same path is sent at most once per 30 minutes
 *     (sessionStorage; mirrors the server-side TRACK_DEDUPE_MINUTES default,
 *     which remains the authoritative window)
 *   * respects Do-Not-Track (navigator.doNotTrack === '1' sends nothing)
 *   * fire-and-forget with keepalive — failures are swallowed on purpose:
 *     statistics must never break or slow down page rendering
 */
import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

const STORAGE_KEY = 'mk:pageview'
const CLIENT_DEDUPE_MS = 30 * 60 * 1000

export function StatsBeacon() {
  const pathname = usePathname()

  useEffect(() => {
    try {
      if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return
      if (!pathname || !pathname.startsWith('/')) return

      let store: Record<string, number> = {}
      try {
        store = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, number>
      } catch {
        store = {}
      }

      const last = typeof store[pathname] === 'number' ? store[pathname] : 0
      if (Date.now() - last < CLIENT_DEDUPE_MS) return
      store[pathname] = Date.now()
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store))

      void fetch('/api/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: pathname }),
        keepalive: true,
      }).catch(() => {
        /* best-effort by design */
      })
    } catch {
      /* never break rendering */
    }
  }, [pathname])

  return null
}
