/**
 * Display-level label translation for post metadata.
 *
 * DB values (post.kind, post.employment, post.level, post.location,
 * post.workplace) are FUNCTIONAL IDENTIFIERS: they are stored in English,
 * drive URL filters (kind=Job, employment=Full-time …) and search. They are
 * never translated in the database or in the URL — only at RENDER time,
 * where these tables map the English value to the matching i18n message key
 * (namespace: postMeta). Unknown values fall back to the raw English string
 * so a new DB value never breaks a page.
 *
 * Section names follow the same policy (see src/lib/constants.ts
 * SECTION_META + the nav comment in every dictionary): always English.
 */
import type { Messages } from '@/i18n/messages/en'

export type PostMetaKey = keyof Messages['postMeta']

/** post.kind → postMeta message key. */
export const KIND_LABEL_KEYS: Record<string, PostMetaKey> = {
  Job: 'kindJob',
  Internship: 'kindInternship',
  Contract: 'kindContract',
  Testnet: 'kindTestnet',
  Quest: 'kindQuest',
  Campaign: 'kindCampaign',
  Airdrop: 'kindAirdrop',
  'Learn & Earn': 'kindLearnEarn',
  'Volume alert': 'kindVolumeAlert',
  Analysis: 'kindAnalysis',
  News: 'kindNews',
  'Career guide': 'kindCareerGuide',
  Research: 'kindResearch',
  Article: 'kindArticle',
  'Graduate program': 'kindGraduateProgram',
  Hackathon: 'kindHackathon',
  Course: 'kindCourse',
  Explainer: 'kindExplainer',
  Opinion: 'kindOpinion',
  Tutorial: 'kindTutorial',
  Update: 'kindUpdate',
}

/** post.employment → postMeta message key. */
export const EMPLOYMENT_LABEL_KEYS: Record<string, PostMetaKey> = {
  'Full-time': 'fullTime',
  'Part-time': 'partTime',
  Internship: 'kindInternship',
  Contract: 'kindContract',
}

/** post.level → postMeta message key. */
export const LEVEL_LABEL_KEYS: Record<string, PostMetaKey> = {
  Intern: 'intern',
  Junior: 'junior',
  Mid: 'mid',
  Senior: 'senior',
  Lead: 'lead',
  Director: 'director',
}

/**
 * post.workplace / well-known post.location values → postMeta message key.
 * "Global" appears as a location on opportunity/grant posts.
 */
export const WORKPLACE_LABEL_KEYS: Record<string, PostMetaKey> = {
  Remote: 'remote',
  Hybrid: 'hybrid',
  'On-site': 'onsite',
  Global: 'global',
}

/**
 * Localized "Added {n} minutes/hours/days ago" (ICU plurals) for a card or
 * article header. Older than 30 days → "Added {date}". `t` is the postMeta
 * translator from next-intl (useTranslations/getTranslations('postMeta')).
 */
export function addedAgoLabel(
  date: Date | string | null | undefined,
  t: (key: PostMetaKey, values?: Record<string, string | number>) => string,
  formatDate: (d: Date | string) => string | null,
): string {
  if (!date) return '—'
  const d = typeof date === 'string' ? new Date(date) : date
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (seconds < 3600) return t('addedMinutesAgo', { count: Math.max(1, Math.floor(seconds / 60)) })
  if (seconds < 86400) return t('addedHoursAgo', { count: Math.floor(seconds / 3600) })
  if (seconds < 30 * 86400) return t('addedDaysAgo', { count: Math.floor(seconds / 86400) })
  return t('addedOn', { date: formatDate(d) ?? '' })
}
