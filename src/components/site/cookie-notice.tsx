'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Cookie } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const STORAGE_KEY = 'merklane_cookie_choice'

interface CookieChoice {
  necessary: true
  analytics: boolean
  marketing: boolean
}

/**
 * Cookie consent banner — explicit choice only: closing or scrolling never
 * implies consent, and the choice can be changed anytime from the footer.
 */
export function CookieNotice() {
  const t = useTranslations('cookie')
  const [visible, setVisible] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [analytics, setAnalytics] = useState(false)
  const [marketing, setMarketing] = useState(false)

  useEffect(() => {
    const show = () => setVisible(true)
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        const timer = setTimeout(show, 700)
        return () => clearTimeout(timer)
      }
    } catch {
      // private mode: show the banner anyway
      const timer = setTimeout(show, 700)
      return () => clearTimeout(timer)
    }
  }, [])

  function persist(choice: CookieChoice) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(choice))
    } catch {
      // storage unavailable — choice lasts for this page view only
    }
    setVisible(false)
    setSettingsOpen(false)
    // No analytics/marketing scripts exist yet; when they ship, they load
    // strictly according to this stored choice.
  }

  if (!visible) return null

  return (
    <>
      <div className="cookie-notice" role="region" aria-label={t('title')}>
        <div>
          <h2 className="row" style={{ gap: 10 }}>
            <Cookie width={20} height={20} aria-hidden />
            {t('title')}
          </h2>
          <p>
            {t('text')}{' '}
            <Link href="/cookies" className="link">
              {t('policy')}
            </Link>
          </p>
        </div>
        <div className="cookie-actions">
          <Button variant="outline" onClick={() => setSettingsOpen(true)}>
            {t('manage')}
          </Button>
          <Button
            onClick={() => persist({ necessary: true, analytics: false, marketing: false })}
            variant="outline"
          >
            {t('rejectOptional')}
          </Button>
          <Button
            style={{ background: 'var(--link)', color: '#081219' }}
            onClick={() => persist({ necessary: true, analytics: true, marketing: true })}
          >
            {t('acceptAll')}
          </Button>
        </div>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('preferencesTitle')}</DialogTitle>
            <DialogDescription>{t('preferencesText')}</DialogDescription>
          </DialogHeader>
          <div className="cookie-category">
            <div>
              <strong>{t('necessaryTitle')}</strong>
              <p>{t('necessaryText')}</p>
            </div>
            <Switch checked disabled aria-label={t('necessaryTitle')} />
          </div>
          <div className="cookie-category">
            <div>
              <strong>{t('analyticsTitle')}</strong>
              <p>{t('analyticsText')}</p>
              <Switch checked={analytics} onCheckedChange={setAnalytics} aria-label={t('analyticsTitle')} />
            </div>
          </div>
          <div className="cookie-category" style={{ borderBottom: 0 }}>
            <div>
              <strong>{t('marketingTitle')}</strong>
              <p>{t('marketingText')}</p>
              <Switch checked={marketing} onCheckedChange={setMarketing} aria-label={t('marketingTitle')} />
            </div>
          </div>
          <div className="cookie-actions" style={{ minWidth: 0, marginTop: 18 }}>
            <Button variant="outline" onClick={() => persist({ necessary: true, analytics: false, marketing: false })}>
              {t('rejectOptional')}
            </Button>
            <Button
              style={{ background: 'var(--link)', color: '#081219' }}
              onClick={() => persist({ necessary: true, analytics, marketing })}
            >
              {t('saveChoices')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
