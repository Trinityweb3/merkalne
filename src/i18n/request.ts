import { getRequestConfig } from 'next-intl/server'
import { routing } from './routing'
import type { Messages } from './messages/en'

/**
 * Server-side request config for next-intl. Loads the dictionary for the
 * active locale (resolved by the proxy from cookie → Accept-Language →
 * default) and falls back to English for anything unexpected — the site
 * always renders, never 500s over a translation.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  const locale = routing.locales.includes(requested as never)
    ? (requested as string)
    : routing.defaultLocale

  let messages: Messages
  try {
    messages = (await import(`./messages/${locale}`)).default as Messages
  } catch {
    messages = (await import('./messages/en')).default
  }

  return { locale, messages: messages as unknown as Record<string, never> }
})
