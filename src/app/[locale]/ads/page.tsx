import type { Metadata } from 'next'
import { AdsWaitlist } from '@/components/site/ads-waitlist'

export const metadata: Metadata = {
  title: 'Merklane Ads — Coming soon',
  description:
    'Search and banner advertising with a transparent auction, per-campaign budgets and honest reporting. Join the waitlist to be first in line.',
}

/**
 * /ads — industry-standard "Coming Soon" page in the Merklane design language,
 * with a working email waitlist capture (POST /api/waitlist → PostgreSQL +
 * Resend confirmation).
 */
export default function AdsPage() {
  return <AdsWaitlist />
}
