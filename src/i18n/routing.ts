import { defineRouting } from 'next-intl/routing'
import { LANGUAGES } from '@/lib/constants'

/**
 * Locale routing for the whole app.
 *
 * `as-needed`: the default locale (en) keeps clean, prefix-free URLs
 * (/about, /blog/…) so every existing link and bookmark keeps working;
 * every other locale gets an explicit prefix (/ru/about, /es/search…).
 * The proxy negotiates the locale via the NEXT_LOCALE cookie (set by
 * the language switcher), then the Accept-Language header, then the default.
 */
export const routing = defineRouting({
  locales: LANGUAGES.map((l) => l.code),
  defaultLocale: 'en',
  localePrefix: 'as-needed',
})

export type AppLocale = (typeof routing.locales)[number]

export const LOCALES = routing.locales as readonly AppLocale[]

export function isAppLocale(value: string): value is AppLocale {
  return (LOCALES as readonly string[]).includes(value)
}
