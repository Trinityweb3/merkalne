import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

/**
 * Security headers (OWASP secure-headers baseline).
 * CSP is intentionally set via a constant string so it survives the
 * standalone Docker build; Next.js inline scripts are allowed via nonce-free
 * 'unsafe-inline' for the framework runtime styles, while connect/frame
 * sources stay locked to self + the OAuth providers we integrate.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Next.js dev/prod inject inline styles & the dev harness script.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      // ytimg thumbnails + the YouTube privacy-enhanced embed player
      // (monthly recap videos on /about — loaded only after a click).
      "img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com https://i.ytimg.com",
      "font-src 'self' data:",
      "connect-src 'self' https://oauth.googleapis.com https://github.com",
      "frame-src https://www.youtube-nocookie.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
]

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
  async rewrites() {
    // Fallback rewrite for RUNTIME uploads (advertiser banners): Next.js
    // only serves files that were in public/ at build time, so /uploads/…
    // files added after the build fall through to this API route, which
    // streams them from disk. Rewrites run AFTER the filesystem check, so
    // the static public/ file still wins whenever it exists (dev, or after
    // a build that copied the folder).
    return [{ source: '/uploads/:path*', destination: '/api/uploads/:path*' }]
  },
}

// next-intl request config (locale → dictionary resolution).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

export default withNextIntl(nextConfig)
