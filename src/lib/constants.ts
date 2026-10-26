/**
 * Domain constants shared by the API layer and the UI.
 */

export const POST_SECTIONS = [
  'intern-junior',
  'mid-senior',
  'opportunities',
  'markets',
  'insights',
  'blog',
] as const

export type PostSection = (typeof POST_SECTIONS)[number]

export const EDITORIAL_SECTIONS = POST_SECTIONS.filter((s) => s !== 'blog') as PostSection[]

export interface SectionMeta {
  slug: PostSection
  title: string
  description: string
}

export const SECTION_META: Record<PostSection, SectionMeta> = {
  'intern-junior': {
    slug: 'intern-junior',
    title: 'Intern/Junior',
    description: 'Internships, junior roles and opportunities to get started.',
  },
  'mid-senior': {
    slug: 'mid-senior',
    title: 'Mid/Senior',
    description: 'Professional roles for experienced Web3, crypto and AI talent.',
  },
  opportunities: {
    slug: 'opportunities',
    title: 'Opportunities',
    description: 'Testnets, campaigns, quests and ecosystem activities.',
  },
  markets: {
    slug: 'markets',
    title: 'Markets',
    description: 'Token events, market signals and news in context.',
  },
  insights: {
    slug: 'insights',
    title: 'Insights',
    description: 'Research, career guides and the ideas behind the headlines.',
  },
  blog: {
    slug: 'blog',
    title: 'Blog',
    description: 'Community posts from registered Merklane users.',
  },
}

export const POST_STATUSES = ['draft', 'published', 'archived', 'deleted'] as const
export type PostStatus = (typeof POST_STATUSES)[number]

export const REACTION_VALUES = ['like', 'dislike'] as const
export type ReactionValue = (typeof REACTION_VALUES)[number]

export const REPORT_REASONS = [
  'Scam or fraud',
  'Dangerous link',
  'False information',
  'Spam',
  'Other',
] as const

/** The 20 supported interface languages (fixed order per product spec). */
export interface LanguageMeta {
  code: string
  label: string
  native: string
  dir: 'ltr' | 'rtl'
}

export const LANGUAGES: LanguageMeta[] = [
  { code: 'en', label: 'English', native: 'English', dir: 'ltr' },
  { code: 'ru', label: 'Russian', native: 'Русский', dir: 'ltr' },
  { code: 'uk', label: 'Ukrainian', native: 'Українська', dir: 'ltr' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
  { code: 'zh', label: 'Chinese (Simplified)', native: '简体中文', dir: 'ltr' },
  { code: 'fa', label: 'Persian', native: 'فارسی', dir: 'rtl' },
  { code: 'ar', label: 'Arabic', native: 'العربية', dir: 'rtl' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা', dir: 'ltr' },
  { code: 'es', label: 'Spanish', native: 'Español', dir: 'ltr' },
  { code: 'pt', label: 'Portuguese', native: 'Português', dir: 'ltr' },
  { code: 'fr', label: 'French', native: 'Français', dir: 'ltr' },
  { code: 'de', label: 'German', native: 'Deutsch', dir: 'ltr' },
  { code: 'ko', label: 'Korean', native: '한국어', dir: 'ltr' },
  { code: 'ja', label: 'Japanese', native: '日本語', dir: 'ltr' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'fil', label: 'Filipino', native: 'Filipino', dir: 'ltr' },
  { code: 'th', label: 'Thai', native: 'ไทย', dir: 'ltr' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt', dir: 'ltr' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe', dir: 'ltr' },
  { code: 'ur', label: 'Urdu', native: 'اردو', dir: 'rtl' },
]

export function isRtlLocale(code: string): boolean {
  return LANGUAGES.find((l) => l.code === code)?.dir === 'rtl'
}

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase()
}

/** Filter option sets rendered by the <Select> dropdowns on section pages. */
export const FILTER_OPTIONS = {
  workplace: ['Remote', 'Hybrid', 'On-site'],
  employment: ['Full-time', 'Part-time', 'Internship', 'Contract'],
  level: ['Intern', 'Junior', 'Mid', 'Senior', 'Lead', 'Director'],
} as const
