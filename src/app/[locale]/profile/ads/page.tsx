import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'
import { getSession } from '@/lib/auth'
import { ProfileDashboard } from '@/components/site/profile-dashboard'

interface PageProps {
  params: Promise<{ locale: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'ads' })
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    robots: { index: false, follow: false },
  }
}

/**
 * /profile/ads — the advertiser dashboard as a tab of the profile cabinet
 * ("Merklane ADS" in the sidebar). Auth-gated like the rest of /profile:
 * anonymous visitors land on the login screen with a return path. The
 * ProfileDashboard opens directly on the ads tab; every other tab link
 * keeps working through /profile?tab=…
 */
export default async function ProfileAdsPage() {
  const session = await getSession()
  if (!session) redirect('/auth?mode=login&next=/profile/ads')

  return (
    <Suspense
      fallback={
        <div className="container page">
          <div className="empty-state card">Loading your profile…</div>
        </div>
      }
    >
      <ProfileDashboard initialTab="ads" />
    </Suspense>
  )
}
