import { createNavigation } from 'next-intl/navigation'
import { routing } from './routing'

/**
 * Locale-aware navigation primitives. `Link` transparently prefixes the
 * current locale (no prefix for the default locale), `usePathname` returns
 * the path WITHOUT the locale prefix, and `useRouter().replace(path, {locale})`
 * is how the language switcher swaps locales in place.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing)
