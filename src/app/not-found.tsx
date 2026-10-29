import Link from 'next/link'
import { Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import './globals.css'

/**
 * GLOBAL 404 — renders its own <html>/<body> (React 19 pattern) because the
 * pass-through root layout owns no document and this page lives outside the
 * [locale] tree, so no NextIntlClientProvider is available here either:
 * plain English + links only. Localized 404s come from
 * app/[locale]/not-found.tsx.
 */
export default function NotFound() {
  return (
    <html lang="en">
      <body className="antialiased">
        <div className="container page" style={{ textAlign: 'center' }}>
          <span className="section-icon" style={{ margin: '0 auto', width: 52, height: 52 }}>
            <Compass width={24} height={24} />
          </span>
          <h1 style={{ marginTop: 18, fontSize: '2.4rem' }}>Page not found</h1>
          <p className="muted" style={{ marginTop: 10, maxWidth: 460, marginInline: 'auto' }}>
            This address does not exist (anymore). The material may have been removed — removed
            posts stay removed everywhere, including search.
          </p>
          <div className="button-row" style={{ justifyContent: 'center', marginTop: 24 }}>
            <Link href="/">
              <Button style={{ background: 'var(--link)', color: '#081219' }}>Go to the home page</Button>
            </Link>
            <Link href="/search">
              <Button variant="outline">Browse all material</Button>
            </Link>
          </div>
        </div>
      </body>
    </html>
  )
}
