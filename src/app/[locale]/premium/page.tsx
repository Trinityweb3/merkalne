import type { Metadata } from 'next'
import { PricingPlans } from '@/components/site/pricing-plans'

export const metadata: Metadata = {
  title: 'Premium',
  description:
    'Free forever for readers. Premium adds a personal Telegram bot and unlimited filters. Premium+ adds editorial publishing quotas, statistics and the user directory.',
}

export default function PremiumPage() {
  return <PricingPlans />
}
