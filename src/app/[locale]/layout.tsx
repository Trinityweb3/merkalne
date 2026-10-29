import type { Metadata, Viewport } from 'next'
import { notFound } from 'next/navigation'
import { Inter } from 'next/font/google'
import { getMessages, setRequestLocale } from 'next-intl/server'
import { NextIntlClientProvider } from 'next-intl'
import { ThemeProvider } from 'next-themes'
import { Toaster } from '@/components/ui/sonner'
import { SessionProvider } from '@/components/providers/session-provider'
import { SiteHeader } from '@/components/site/site-header'
import { SiteFooter } from '@/components/site/site-footer'
import { DonationTab } from '@/components/site/donation-tab'
import { CookieNotice } from '@/components/site/cookie-notice'
import { StatsBeacon } from '@/components/site/stats-beacon'
import { isRtlLocale } from '@/lib/constants'
import { LOCALES, isAppLocale } from '@/i18n/routing'
import '../globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: 'Merklane | Explore Web3',
    template: '%s | Merklane',
  },
  description:
    'Explore Web3, crypto, blockchain and AI opportunities. Jobs, opportunities and insights — all in one place.',
  // Text-brand strategy: the graphical logo is favicon-only. /api/favicon
  // serves the Telegram-CMS upload (falls back to the stock /favicon.svg),
  // so a "Change logo" upload refreshes the browser tab — never the page.
  icons: { icon: '/api/favicon', apple: '/api/favicon' },
  openGraph: {
    title: 'Merklane | Explore Web3',
    description: 'Jobs, opportunities and insights. All in one place.',
    type: 'website',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

/** Pre-render every locale shell; deeper pages stay dynamic as before. */
export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!isAppLocale(locale)) notFound()

  // Enables static rendering where the page allows it.
  setRequestLocale(locale)

  // Providing messages explicitly avoids relying on the implicit
  // request-config inheritance in every edge case.
  const messages = await getMessages()

  return (
    <html
      lang={locale}
      dir={isRtlLocale(locale) ? 'rtl' : 'ltr'}
      suppressHydrationWarning
    >
      <body className={`${inter.variable} antialiased`}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
            <SessionProvider>
              <div className="flex min-h-svh flex-col">
                <div className="contents">
                  <SiteHeader />
                </div>
                <main className="flex-1">{children}</main>
                <SiteFooter />
              </div>
              <DonationTab />
              <CookieNotice />
              <StatsBeacon />
              <Toaster position="top-center" richColors closeButton />
            </SessionProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
