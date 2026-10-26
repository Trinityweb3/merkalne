'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'
import { Search, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/site/theme-toggle'
import { LanguagePicker } from '@/components/site/language-picker'
import { UserMenu } from '@/components/site/user-menu'
import { useSession } from '@/components/providers/session-provider'

interface NavItem {
  href: string
  key: 'internJunior' | 'midSenior' | 'opportunities' | 'markets' | 'insights' | 'blog' | 'about'
  plus?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { href: '/intern-junior', key: 'internJunior' },
  { href: '/mid-senior', key: 'midSenior' },
  { href: '/opportunities', key: 'opportunities' },
  { href: '/markets', key: 'markets' },
  { href: '/insights', key: 'insights' },
  { href: '/blog', key: 'blog', plus: true },
  { href: '/about', key: 'about' },
]

export function SiteHeader() {
  const t = useTranslations('nav')
  const th = useTranslations('header')
  // next-intl's usePathname strips the locale prefix, so comparisons against
  // the hrefs above keep working in every language.
  const pathname = usePathname()
  const { user, loading } = useSession()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [lastPath, setLastPath] = useState(pathname)

  // Close the mobile drawer on route change — adjusted during render instead
  // of in an effect (React's recommended pattern for derived state resets).
  if (lastPath !== pathname) {
    setLastPath(pathname)
    setMobileOpen(false)
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

  return (
    <>
      <header className="header">
        <div className="container header-inner">
          <Link href="/" className="wordmark" aria-label="Merklane home">
            Merklane<span>.</span>
          </Link>

          <nav className="nav" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => (
              <span key={item.href}>
                <Link href={item.href} className={isActive(item.href) ? 'active' : ''}>
                  {t(item.key)}
                </Link>
                {item.plus ? (
                  <Link
                    href="/profile?compose=1"
                    className="blog-plus"
                    aria-label={th('createPost')}
                    title={th('createPost')}
                  >
                    +
                  </Link>
                ) : null}
              </span>
            ))}
          </nav>

          <div className="header-tools">
            <Link href="/premium" className="header-premium small link">
              {th('premium')}
            </Link>
            <Link href="/search" className="icon-button" aria-label={th('search')}>
              <Search width={18} height={18} />
            </Link>
            <div className="language-picker">
              <LanguagePicker />
            </div>
            <ThemeToggle />
            {loading ? (
              <div className="h-8 w-16 animate-pulse rounded-md bg-muted" aria-hidden />
            ) : user ? (
              <UserMenu />
            ) : (
              <Link href="/auth?mode=login">
                <Button variant="outline" size="sm">
                  {th('logIn')}
                </Button>
              </Link>
            )}
            <button
              className="icon-button mobile-only"
              aria-label={mobileOpen ? th('closeMenu') : th('openMenu')}
              onClick={() => setMobileOpen((v) => !v)}
            >
              {mobileOpen ? <X width={22} height={22} /> : <Menu width={22} height={22} />}
            </button>
          </div>
        </div>
      </header>

      {mobileOpen ? (
        <nav className="mobile-nav container" aria-label="Mobile navigation">
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className={isActive(item.href) ? 'active' : ''}>
              {t(item.key)}
              {item.plus ? <span style={{ color: 'var(--link)', marginLeft: 8 }}>+</span> : null}
            </Link>
          ))}
          <Link href="/premium" className={isActive('/premium') ? 'active' : ''}>
            {th('premium')}
          </Link>
          <Link href="/search" className={isActive('/search') ? 'active' : ''}>
            {th('search')}
          </Link>
        </nav>
      ) : null}
    </>
  )
}
