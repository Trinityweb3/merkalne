'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  EMPLOYMENT_LABEL_KEYS,
  KIND_LABEL_KEYS,
  LEVEL_LABEL_KEYS,
  WORKPLACE_LABEL_KEYS,
  type PostMetaKey,
} from '@/lib/post-labels'
// Server-safe data module — the filter DEFINITIONS must NOT live in this
// "use client" file: server components importing a plain object from a
// client module receive a client-reference proxy (Object.keys → []), which
// silently broke the filter bar until now. See src/lib/section-filters.ts.
import { SECTION_FILTERS, type FilterDef, type FilterKey } from '@/lib/section-filters'

/** English DB value → postMeta message key, per filter group (display only). */
const OPTION_LABEL_KEYS: Record<FilterKey, Record<string, PostMetaKey>> = {
  kind: KIND_LABEL_KEYS,
  workplace: WORKPLACE_LABEL_KEYS,
  employment: EMPLOYMENT_LABEL_KEYS,
  level: LEVEL_LABEL_KEYS,
}

/**
 * Filter bar on section pages. Within a group the user picks one value (the
 * URL keeps every choice, so a shared link reproduces the same view).
 * Resetting a filter returns the full list. Only applicable filters render
 * (e.g. no salary filter on Insights, per the product rules).
 *
 * Option VALUES stay the raw English identifiers (they go into the URL and
 * the API); only the visible labels are localized.
 */
export function SectionFilters({ filters }: { filters: FilterDef[] }) {
  const t = useTranslations('sections')
  const tm = useTranslations('postMeta')
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const [kind, setKind] = useState(searchParams.get('kind') ?? '')
  const [workplace, setWorkplace] = useState(searchParams.get('workplace') ?? '')
  const [employment, setEmployment] = useState(searchParams.get('employment') ?? '')
  const [level, setLevel] = useState(searchParams.get('level') ?? '')

  // Keep local state in sync when the URL changes (back/forward navigation).
  // Adjusted during render — React's recommended pattern for resetting
  // derived state, no effect needed.
  const paramsKey = searchParams.toString()
  const [lastKey, setLastKey] = useState(paramsKey)
  if (lastKey !== paramsKey) {
    setLastKey(paramsKey)
    setKind(searchParams.get('kind') ?? '')
    setWorkplace(searchParams.get('workplace') ?? '')
    setEmployment(searchParams.get('employment') ?? '')
    setLevel(searchParams.get('level') ?? '')
  }

  function apply(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    params.delete('page') // any filter change resets pagination
    startTransition(() => {
      router.push(`?${params.toString()}`, { scroll: false })
    })
  }

  const values: Record<FilterKey, string> = { kind, workplace, employment, level }
  const setters: Record<FilterKey, (v: string) => void> = {
    kind: setKind,
    workplace: setWorkplace,
    employment: setEmployment,
    level: setLevel,
  }

  const hasActive = filters.some((f) => values[f.key])

  // Display label for an option; unknown values fall back to the raw string.
  const optionLabel = (filter: FilterDef, option: string) =>
    tm(OPTION_LABEL_KEYS[filter.key][option] ?? 'post')

  return (
    <div className="filters" aria-label={t('filtersAria')} data-pending={isPending || undefined}>
      {filters.map((filter) => (
        <Select
          key={filter.key}
          value={values[filter.key]}
          onValueChange={(v) => {
            setters[filter.key](v)
            apply(filter.key, v)
          }}
        >
          <SelectTrigger aria-label={t(filter.labelKey)}>
            <SelectValue placeholder={t(filter.labelKey)} />
          </SelectTrigger>
          <SelectContent>
            {filter.options.map((option) => (
              <SelectItem key={option} value={option}>
                {optionLabel(filter, option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
      {hasActive ? (
        <button
          type="button"
          className="chip selected"
          onClick={() => startTransition(() => router.push('?', { scroll: false }))}
        >
          {t('clearFilters')}
        </button>
      ) : null}
    </div>
  )
}
