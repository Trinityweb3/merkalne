import { redirect } from 'next/navigation'

interface PageProps {
  params: Promise<{ locale: string }>
}

/**
 * /ads → /profile/ads (permanent move). The advertiser dashboard lives in
 * the profile cabinet now — "Merklane ADS" tab. The redirect keeps the
 * visitor in their language for prefixed locales (/ru/ads → /ru/profile/ads).
 */
export default async function AdsRedirectPage({ params }: PageProps) {
  const { locale } = await params
  redirect(locale === 'en' ? '/profile/ads' : `/${locale}/profile/ads`)
}
