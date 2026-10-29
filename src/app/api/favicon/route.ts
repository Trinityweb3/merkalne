import { NextResponse } from 'next/server'
import { getSiteOverrides } from '@/lib/site-settings'

/**
 * GET /api/favicon — the browser tab icon.
 *
 * Branding rule: the graphical logo is NEVER rendered on the page — the UI
 * carries the text wordmark "Merklane." only. The image lives exclusively in
 * two places: the browser tab (this route) and social media (OG assets).
 *
 * Source of truth is the Telegram admin bot's "Change logo" upload
 * (SiteSetting `current_logo_url`, stored as a base64 data URL). While that
 * setting is empty the stock brand mark from /favicon.svg is served, so the
 * tab icon is always honest.
 *
 * Both layouts point `icons` metadata here, so a fresh upload shows up in
 * tabs once the 60 s SiteSetting cache expires (mirrored by the response
 * Cache-Control, which keeps browsers from pinning the old icon for long).
 */

/** Stock mark served until the operator uploads a logo. */
const DEFAULT_ICON = '/favicon.svg'

/** `data:<mime>;base64,<payload>` — the storage format the admin bot writes. */
const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i

/** Matches the SiteSetting read cache: a new logo lands within a minute. */
const CACHE_CONTROL = 'public, max-age=60'

function defaultIcon(req: Request): NextResponse {
  const res = NextResponse.redirect(new URL(DEFAULT_ICON, req.url), 307)
  res.headers.set('Cache-Control', CACHE_CONTROL)
  return res
}

export async function GET(req: Request) {
  let logo: string | undefined
  try {
    logo = (await getSiteOverrides()).logo?.trim()
  } catch {
    // DB hiccup — keep the stock tab icon instead of erroring out.
    return defaultIcon(req)
  }

  if (logo) {
    const m = DATA_URL.exec(logo)
    if (m) {
      const bytes = Buffer.from(m[2], 'base64')
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          'Content-Type': m[1],
          'Cache-Control': CACHE_CONTROL,
        },
      })
    }
    // Legacy/external plain-URL values: let the browser fetch the source.
    if (/^https?:\/\//i.test(logo)) {
      const res = NextResponse.redirect(logo)
      res.headers.set('Cache-Control', CACHE_CONTROL)
      return res
    }
  }

  return defaultIcon(req)
}
