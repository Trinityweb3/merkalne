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

/** Section rail header: icon + linked title + description + "View all". */
export function SectionHead({ section }: { section: PostSection }) {
  const meta = SECTION_META[section]
  const Icon = SECTION_ICONS[section]
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
          <p>{meta.description}</p>
        </div>
      </div>
      <div className="row small">
        <Link href={`/${meta.slug}`} className="link">
          View all
        </Link>
      </div>
    </div>
  )
}

export { SECTION_ICONS }
