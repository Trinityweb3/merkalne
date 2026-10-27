import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { ComponentType } from 'react'
import {
  BookOpen,
  Briefcase,
  ChartNoAxesCombined,
  Compass,
  GraduationCap,
  PenLine,
} from 'lucide-react'
import { SECTION_META, type PostSection } from '@/lib/constants'

const SECTION_ICONS: Record<PostSection, ComponentType<{ width?: number; height?: number }>> = {
  'intern-junior': GraduationCap,
  'mid-senior': Briefcase,
  opportunities: Compass,
  markets: ChartNoAxesCombined,
  insights: BookOpen,
  blog: PenLine,
}

/** i18n key (namespace `sections`) holding each section's DESCRIPTION. */
const SECTION_DESC_KEYS: Record<PostSection, string> = {
  'intern-junior': 'internJuniorDesc',
  'mid-senior': 'midSeniorDesc',
  opportunities: 'opportunitiesDesc',
  markets: 'marketsDesc',
  insights: 'insightsDesc',
  blog: 'blogDesc',
}

/**
 * Section rail header: icon + linked title + description + "View all".
 * The TITLE is the section name — a functional identifier that stays
 * English in every locale (see the nav note in the dictionaries); only the
 * description and the "View all" link are localized.
 */
export function SectionHead({ section }: { section: PostSection }) {
  const meta = SECTION_META[section]
  const Icon = SECTION_ICONS[section]
  const ts = useTranslations('sections')
  const tc = useTranslations('common')
  return (
    <div className="section-title">
      <div className="row">
        <span className="section-icon">
          <Icon width={19} height={19} />
        </span>
        <div>
          <Link href={`/${meta.slug}`}>
            <h2>{meta.title}</h2>
          </Link>
          <p>{ts(SECTION_DESC_KEYS[section] as Parameters<typeof ts>[0])}</p>
        </div>
      </div>
      <div className="row small">
        <Link href={`/${meta.slug}`} className="link">
          {tc('viewAll')}
        </Link>
      </div>
    </div>
  )
}

export { SECTION_ICONS }
