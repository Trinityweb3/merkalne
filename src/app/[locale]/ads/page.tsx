import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSession } from '@/lib/auth'
import { AdsDashboard } from '@/components/site/ads/ads-dashboard'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ locale: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'ads' })
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    robots: { index: false, follow: true },
  }
}

/**
 * /ads — the advertiser dashboard (create campaigns, watch the weighted
 * auction spend live, top up the balance with crypto). Auth-gated like the
 * profile cabinet: anonymous visitors land on the login screen with a
 * `next=/ads` return path.
 */
export default async function AdsPage({ params }: PageProps) {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'ads' })
  const session = await getSession()
  if (!session) redirect('/auth?mode=login&next=/ads')

  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('intro')}</p>
        </div>
      </div>

      <div className="card ads-how-card">
        <h3>{t('howTitle')}</h3>
        <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
          {t('howText')}
        </p>
      </div>

      <AdsDashboard />
    </div>
  )
}
