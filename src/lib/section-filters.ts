/**
 * Section filter DEFINITIONS — server-safe data module.
 *
 * WHY THIS FILE EXISTS: the filter bar component
 * (src/components/site/section-filters.tsx) is a "use client" module. In the
 * App Router, importing a NON-COMPONENT value (like this constant) from a
 * "use client" file into a server component yields a client-reference proxy,
 * not the actual data — `SECTION_FILTERS[section]` was always undefined and
 * the filter dropdowns silently rendered empty (a production bug until now).
 * Keeping the plain data here (no "use client") lets BOTH the server page
 * and the client component import the real object.
 *
 * `labelKey` is an i18n key (namespace `sections`); the option VALUES stay
 * raw English identifiers — they go into the URL (kind=Job,
 * employment=Full-time …) and the API, and are translated only at display
 * time (see src/lib/post-labels.ts).
 */
import { FILTER_OPTIONS } from './constants'

export type FilterKey = 'kind' | 'workplace' | 'employment' | 'level'

export interface FilterDef {
  key: FilterKey
  /** i18n key in the `sections` namespace for the display label. */
  labelKey:
    | 'filterType'
    | 'filterActivity'
    | 'filterEventType'
    | 'filterMaterialType'
    | 'filterEmployment'
    | 'filterLevel'
    | 'filterWorkplace'
  /** Raw English option values (URL/DB identifiers). */
  options: string[]
}

export const SECTION_FILTERS: Record<string, FilterDef[]> = {
  'intern-junior': [
    { key: 'kind', labelKey: 'filterType', options: ['Job', 'Internship', 'Graduate program', 'Hackathon', 'Course', 'Learn & Earn'] },
    { key: 'workplace', labelKey: 'filterWorkplace', options: [...FILTER_OPTIONS.workplace] },
    { key: 'employment', labelKey: 'filterEmployment', options: [...FILTER_OPTIONS.employment] },
    { key: 'level', labelKey: 'filterLevel', options: ['Intern', 'Junior'] },
  ],
  'mid-senior': [
    { key: 'kind', labelKey: 'filterType', options: ['Job'] },
    { key: 'workplace', labelKey: 'filterWorkplace', options: [...FILTER_OPTIONS.workplace] },
    { key: 'employment', labelKey: 'filterEmployment', options: [...FILTER_OPTIONS.employment] },
    { key: 'level', labelKey: 'filterLevel', options: ['Mid', 'Senior', 'Lead', 'Director'] },
  ],
  opportunities: [
    { key: 'kind', labelKey: 'filterActivity', options: ['Testnet', 'Quest', 'Campaign', 'Learn & Earn', 'Airdrop'] },
  ],
  markets: [
    { key: 'kind', labelKey: 'filterEventType', options: ['Volume alert', 'Analysis', 'News', 'Research'] },
  ],
  insights: [
    { key: 'kind', labelKey: 'filterMaterialType', options: ['Career guide', 'Research', 'Explainer', 'Opinion'] },
  ],
  blog: [{ key: 'kind', labelKey: 'filterType', options: ['Article', 'Tutorial', 'Opinion', 'Update'] }],
}
