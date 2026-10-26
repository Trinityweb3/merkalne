'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations('common')

  useEffect(() => {
    console.error('[app] runtime error:', error)
  }, [error])

  return (
    <div className="container page" style={{ textAlign: 'center', paddingTop: 90 }}>
      <span className="section-icon" style={{ margin: '0 auto', width: 52, height: 52 }}>
        <AlertTriangle width={24} height={24} style={{ color: 'var(--negative)' }} />
      </span>
      <h1 style={{ marginTop: 18, fontSize: '2.2rem' }}>{t('errorTitle')}</h1>
      <p className="muted" style={{ marginTop: 10, maxWidth: 460, marginInline: 'auto' }}>
        {t('errorText')}{error.digest ? ` (ref ${error.digest.slice(0, 8)})` : ''}
      </p>
      <div className="button-row" style={{ justifyContent: 'center', marginTop: 24 }}>
        <Button onClick={reset} style={{ background: 'var(--link)', color: '#081219' }}>
          {t('tryAgain')}
        </Button>
        <Link href="/">
          <Button variant="outline">{t('home')}</Button>
        </Link>
      </div>
    </div>
  )
}
