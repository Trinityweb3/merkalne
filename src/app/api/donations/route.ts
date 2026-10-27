import { NextResponse } from 'next/server'
import { getDonationWallets } from '@/lib/donations'

/**
 * GET /api/donations — public, cacheable wallet list for the support sheet.
 * Returns only what is configured in the environment; empty list otherwise.
 */
export async function GET() {
  return NextResponse.json(
    { wallets: getDonationWallets() },
    { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' } },
  )
}
