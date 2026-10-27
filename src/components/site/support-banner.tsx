'use client'

import { Link } from '@/i18n/navigation'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useSession } from '@/components/providers/session-provider'

/**
 * Bottom support banner — fixed at the viewport bottom for guests and Free
 * users, becomes an in-flow block once the visitor scrolls to it, and is
 * hidden entirely for active Premium/Premium+ members (stage-2 rule,
 * applied from day one).
 */
export function SupportBanner() {
  const t = useTranslations('support')
  const { user, loading } = useSession()
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: '-16px 0px -16px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Premium subscribers never see the upsell banner.
  if (!loading && user && user.role !== 'user') return <div className="support-space" aria-hidden />

  return (
    <div className="support-space">
      <div ref={sentinelRef} aria-hidden style={{ minHeight: 1 }} />
      <div className={`support-banner ${inView ? '' : 'fixed'}`}>
        <div>
          <h3>{t('title')}</h3>
          <p>
            {t('text')} <span className="optional">{t('textOptional')}</span>
          </p>
        </div>
        <div className="stack" style={{ gap: 5, flexShrink: 0 }}>
          <Link href="/premium">
            <Button size="sm" style={{ background: 'var(--link)', color: '#081219' }}>
              {t('cta')}
            </Button>
          </Link>
          <span className="tiny muted">{t('price')}</span>
        </div>
      </div>
    </div>
  )
}
