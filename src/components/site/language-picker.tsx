'use client'

import { useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter, usePathname } from '@/i18n/navigation'
import { Check, Languages } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LANGUAGES, isRtlLocale } from '@/lib/constants'
import { LOCALES } from '@/i18n/routing'
import { api } from '@/lib/api-client'

/**
 * Interface locale picker — 20 supported languages in the fixed product order.
 *
 * Selecting a language does three things:
 *  1. sets the NEXT_LOCALE cookie (read by the proxy on every request,
 *     so the choice survives navigation and reloads),
 *  2. navigates to the SAME page under the new locale (/about ⇄ /ru/about —
 *     the default locale keeps unprefixed URLs),
 *  3. syncs the preference to the account for signed-in visitors
 *     (best-effort: an error never blocks or reverts the switch).
 */
export function LanguagePicker() {
  const t = useTranslations('header')
  // Partial hydration guard: the server may still render before the client
  // locale is known; fall back to the first segment of the document.
  const localeFromContext = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const [, startTransition] = useTransition()

  const locale = LOCALES.includes(localeFromContext as never) ? localeFromContext : 'en'

  function changeLocale(next: string) {
    if (next === locale) return

    // 1. Persist the choice for the proxy (1 year, site-wide).
    document.cookie = `NEXT_LOCALE=${encodeURIComponent(next)};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`

    // 2. Same page, new locale — the URL visibly changes (/ru/about).
    //    The <html lang/dir> attributes follow from the [locale] layout.
    startTransition(() => {
      router.replace(pathname, { locale: next })
    })

    // 3. Best-effort account sync — never blocks or reverts the switch.
    void api('/api/preferences', { method: 'PUT', body: { locale: next } }).catch(() => {})
  }

  const current = LANGUAGES.find((l) => l.code === locale)

  return (
    <Select value={locale} onValueChange={changeLocale}>
      <SelectTrigger
        className="w-[66px] border-0 shadow-none dark:bg-input/30"
        aria-label={t('language')}
        size="default"
      >
        <SelectValue placeholder="EN">
          <span className="flex items-center gap-2">
            <Languages className="size-4 text-muted-foreground" aria-hidden />
            <span>{(current?.code ?? locale).toUpperCase()}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-96">
        <SelectGroup>
          <SelectLabel>{t('interfaceLanguage')}</SelectLabel>
          {LANGUAGES.map((lang) => (
            <SelectItem key={lang.code} value={lang.code} dir={lang.dir}>
              <span className="flex items-center justify-between gap-3">
                <span>{lang.native}</span>
                <span className="flex items-center gap-1.5">
                  {isRtlLocale(lang.code) ? <span className="badge">RTL</span> : null}
                  {lang.code === locale ? <Check className="size-3.5" /> : null}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
