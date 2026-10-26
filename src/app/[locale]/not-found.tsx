import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchBox } from '@/components/site/search-box'

export default async function NotFound() {
  const t = await getTranslations('common')

  return (
    <div className="container page" style={{ textAlign: 'center' }}>
      <span className="section-icon" style={{ margin: '0 auto', width: 52, height: 52 }}>
        <Compass width={24} height={24} />
      </span>
      <h1 style={{ marginTop: 18, fontSize: '2.4rem' }}>{t('notFoundTitle')}</h1>
      <p className="muted" style={{ marginTop: 10, maxWidth: 460, marginInline: 'auto' }}>
        {t('notFoundText')}
      </p>
      <div style={{ maxWidth: 560, margin: '26px auto 0' }}>
        <SearchBox />
      </div>
      <div className="button-row" style={{ justifyContent: 'center', marginTop: 24 }}>
        <Link href="/">
          <Button style={{ background: 'var(--link)', color: '#081219' }}>{t('backHome')}</Button>
        </Link>
        <Link href="/search">
          <Button variant="outline">{t('search')}</Button>
        </Link>
      </div>
    </div>
  )
}
