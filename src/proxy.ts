import createMiddleware from 'next-intl/middleware'
import { NextResponse, type NextRequest } from 'next/server'
import { routing } from '@/i18n/routing'

/**
 * Edge proxy (Next.js 16 renamed the "middleware" convention to "proxy";
 * same runtime position: before routing, after static assets):
 *  - resolves the locale (cookie → Accept-Language → default) and keeps the
 *    URL honest: /ru/about stays /ru/about, /about renders the default
 *    locale without a prefix (next-intl, `as-needed`)
 *  - seeds the CSRF double-submit cookie
 *  - adds a baseline of security headers to every response (Next.js config
 *    adds the full set for rendered routes; this covers everything else)
 *  - cheap gate for /profile and /alerts: visitors without a session cookie
 *    are bounced to the auth screen (real authorisation still happens
 *    server-side). Works with and without a locale prefix.
 */

const CSRF_COOKIE = 'merklane_csrf'
const SESSION_COOKIE = 'merklane_session'

const handleI18nRouting = createMiddleware(routing)

/** Non-default locales get a URL prefix; the default (en) does not. */
const PREFIXED = routing.locales.filter((l) => l !== routing.defaultLocale)

function splitLocale(pathname: string): { prefix: string; path: string } {
  for (const locale of PREFIXED) {
    if (pathname === `/${locale}`) return { prefix: `/${locale}`, path: '/' }
    if (pathname.startsWith(`/${locale}/`)) {
      return { prefix: `/${locale}`, path: pathname.slice(locale.length + 1) }
    }
  }
  return { prefix: '', path: pathname }
}

export function proxy(req: NextRequest) {
  const res = handleI18nRouting(req)

  if (!req.cookies.get(CSRF_COOKIE)) {
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
    res.cookies.set(CSRF_COOKIE, token, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 12,
    })
  }

  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.headers.set('X-DNS-Prefetch-Control', 'off')
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin')

  const { pathname, search } = req.nextUrl
  const { prefix, path } = splitLocale(pathname)
  // Session-gated surfaces: profile cabinet + job-alerts channel manager.
  if ((path.startsWith('/profile') || path.startsWith('/alerts')) && !req.cookies.get(SESSION_COOKIE)) {
    const url = req.nextUrl.clone()
    // Keep the visitor in their language: /ru/profile → /ru/auth?…
    url.pathname = `${prefix}/auth`
    url.search = `?mode=login&next=${encodeURIComponent(pathname + search)}`
    return NextResponse.redirect(url)
  }

  return res
}

export const config = {
  matcher: [
    // Pages only: skip API routes, Next internals, and any file with an
    // extension (favicon, logo.svg, …).
    //
    // `en(?:/|$)` — the DEFAULT locale's prefix is excluded because the
    // next-intl proxy internally rewrites unprefixed URLs (/about →
    // /en/about) so the [locale] segment resolves. On Next 16 the proxy
    // re-enters itself for that internal rewrite, where next-intl would
    // otherwise strip the "redundant" default prefix and redirect back —
    // an infinite loop. Excluded here, the rewritten /en/… path renders
    // directly; explicit /en/… visits work too (they simply keep the prefix
    // instead of being canonicalized to the unprefixed URL).
    '/((?!api|_next/static|_next/image|_vercel|en(?:/|$)|.*\\..*).*)',
  ],
}
