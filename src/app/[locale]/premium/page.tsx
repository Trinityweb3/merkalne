import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { PricingPlans } from '@/components/site/pricing-plans'
import { allowedCoins, blockbeeConfigured } from '@/lib/ads/blockbee'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ locale: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'premium' })
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  }
}

/**
 * /premium — the pricing page. The plan prices render from the server-side
 * catalog (src/lib/premium/plan.ts) via the client component; this server
 * component contributes the deployment's checkout config (which coins are
 * offered, whether BlockBee is configured) so the modal can render the right
 * flow without a second round-trip.
 */
export default async function PremiumPage() {
  return <PricingPlans configured={blockbeeConfigured()} coins={allowedCoins()} />
}
