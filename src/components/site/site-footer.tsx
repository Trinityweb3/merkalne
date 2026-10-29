import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'

export function SiteFooter() {
  const t = useTranslations('footer')

  return (
    <footer className="footer mt-auto">
      <div className="container">
        <div className="footer-grid">
          <div>
            <Link href="/" className="wordmark">
              Merklane<span>.</span>
            </Link>
            <p className="small" style={{ marginTop: 9 }}>
              {t('tagline')}
            </p>
          </div>
          <div className="footer-links">
            <Link href="/about">{t('about')}</Link>
            <Link href="/premium">{t('premium')}</Link>
            <Link href="/alerts">{t('jobAlerts')}</Link>
            <Link href="/recruiter">{t('premiumTools')}</Link>
            <Link href="/profile/ads">{t('ads')}</Link>
            <Link href="/contact">{t('contact')}</Link>
          </div>
        </div>
        <p className="footer-safety">
          {t('safetyText')}{' '}
          <Link href="/risk" className="link">
            {t('safetyLink')}
          </Link>{' '}
          {t('reportLink')}
          {'.'}
        </p>
        <div className="row between wrap small" style={{ marginTop: 24 }}>
          <span>{t('copyright', { year: 2026 })}</span>
          <div className="footer-links">
            <Link href="/terms">{t('terms')}</Link>
            <Link href="/privacy">{t('privacy')}</Link>
            <Link href="/risk">{t('safetyRisk')}</Link>
            <Link href="/cookies">{t('cookies')}</Link>
          </div>
        </div>
      </div>
    </footer>
  )
}
