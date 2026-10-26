'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FILTER_OPTIONS } from '@/lib/constants'

interface FilterDef {
  key: 'kind' | 'workplace' | 'employment' | 'level'
  label: string
  options: string[]
}

/**
 * Filter bar on section pages. Within a group the user picks one value (the
 * URL keeps every choice, so a shared link reproduces the same view).
 * Resetting a filter returns the full list. Only applicable filters render
 * (e.g. no salary filter on Insights, per the product rules).
 */
export function SectionFilters({ filters }: { filters: FilterDef[] }) {
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

  const values: Record<FilterDef['key'], string> = { kind, workplace, employment, level }
  const setters: Record<FilterDef['key'], (v: string) => void> = {
    kind: setKind,
    workplace: setWorkplace,
    employment: setEmployment,
    level: setLevel,
  }

  const hasActive = filters.some((f) => values[f.key])

  return (
    <div className="filters" aria-label="Section filters" data-pending={isPending || undefined}>
      {filters.map((filter) => (
        <Select
          key={filter.key}
          value={values[filter.key]}
          onValueChange={(v) => {
            setters[filter.key](v)
            apply(filter.key, v)
          }}
        >
          <SelectTrigger aria-label={filter.label}>
            <SelectValue placeholder={filter.label} />
          </SelectTrigger>
          <SelectContent>
            {filter.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
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
          Clear filters ×
        </button>
      ) : null}
    </div>
  )
}

export const SECTION_FILTERS: Record<string, FilterDef[]> = {
  'intern-junior': [
    { key: 'kind', label: 'Type', options: ['Job', 'Internship', 'Graduate program', 'Hackathon', 'Course', 'Learn & Earn'] },
    { key: 'workplace', label: 'Remote / On-site', options: [...FILTER_OPTIONS.workplace] },
    { key: 'employment', label: 'Employment', options: [...FILTER_OPTIONS.employment] },
    { key: 'level', label: 'Level', options: ['Intern', 'Junior'] },
  ],
  'mid-senior': [
    { key: 'kind', label: 'Type', options: ['Job'] },
    { key: 'workplace', label: 'Remote / On-site', options: [...FILTER_OPTIONS.workplace] },
    { key: 'employment', label: 'Employment', options: [...FILTER_OPTIONS.employment] },
    { key: 'level', label: 'Level', options: ['Mid', 'Senior', 'Lead', 'Director'] },
  ],
  opportunities: [
    { key: 'kind', label: 'Activity', options: ['Testnet', 'Quest', 'Campaign', 'Learn & Earn', 'Airdrop'] },
  ],
  markets: [
    { key: 'kind', label: 'Event type', options: ['Volume alert', 'Analysis', 'News', 'Research'] },
  ],
  insights: [
    { key: 'kind', label: 'Material type', options: ['Career guide', 'Research', 'Explainer', 'Opinion'] },
  ],
  blog: [{ key: 'kind', label: 'Type', options: ['Article', 'Tutorial', 'Opinion', 'Update'] }],
}
