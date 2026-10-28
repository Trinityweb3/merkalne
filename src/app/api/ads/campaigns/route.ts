import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { campaignStats } from '@/lib/ads/auction'
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, topUpMode } from '@/lib/ads/topup'
import { allowedCoins } from '@/lib/ads/blockbee'

export const dynamic = 'force-dynamic'

const MAX_ACTIVE_CAMPAIGNS = 12

const createSchema = z.object({
  title: z.string().trim().min(3).max(80),
  body: z.string().trim().min(3).max(200),
  ctaUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//, 'The destination URL must use https'),
  ctaLabel: z.string().trim().max(32).optional().or(z.literal('')),
  bidPerView: z.coerce.number().int().min(1).max(50), // 1¢–50¢ per view
})

/**
 * GET /api/ads/campaigns — the signed-in advertiser's campaigns with live
 * view/click counts (used by the dashboard's refresh after mutations). Also
 * returns the active top-up configuration (mode + offered coins + limits)
 * so the top-up modal can render the right flow (BlockBee coin picker vs
 * manual/simulate) without a second round-trip.
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const campaigns = await db.adCampaign.findMany({
      where: { advertiserId: session.user.id },
      orderBy: { createdAt: 'desc' },
    })
    const stats = await campaignStats(campaigns.map((c) => c.id))

    return jsonOk({
      campaigns: campaigns.map((c) => ({
        id: c.id,
        title: c.title,
        body: c.body,
        ctaUrl: c.ctaUrl,
        ctaLabel: c.ctaLabel,
        balance: c.balance,
        bidPerView: c.bidPerView,
        status: c.status,
        createdAt: c.createdAt.toISOString(),
        impressions: stats.get(c.id)?.impressions ?? 0,
        clicks: stats.get(c.id)?.clicks ?? 0,
      })),
      topUp: {
        mode: topUpMode(),
        coins: allowedCoins(),
        minCents: TOPUP_MIN_CENTS,
        maxCents: TOPUP_MAX_CENTS,
      },
    })
  } catch (err) {
    return handleRouteError(err)
  }
}

/**
 * POST /api/ads/campaigns — create a campaign (starts PAUSED with balance 0
 * until the first crypto top-up is confirmed — no free impressions, ever).
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const rl = rateLimit(`ads-campaign-create:${session.user.id}`, 6, 60_000)
    if (!rl.ok) return jsonError('Too many campaigns created — try again in a minute.', 429)

    const parsed = createSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError('Invalid campaign', 400, { issues: parsed.error.issues })
    }
    const { title, body, ctaUrl, ctaLabel, bidPerView } = parsed.data

    const activeCount = await db.adCampaign.count({
      where: { advertiserId: session.user.id, status: { in: ['active', 'paused'] } },
    })
    if (activeCount >= MAX_ACTIVE_CAMPAIGNS) {
      return jsonError(
        `Campaign limit reached (${MAX_ACTIVE_CAMPAIGNS}) — pause or let an old one end first.`,
        400,
      )
    }

    const campaign = await db.adCampaign.create({
      data: {
        advertiserId: session.user.id,
        title,
        body,
        ctaUrl,
        ctaLabel: ctaLabel ? ctaLabel : null,
        bidPerView,
        balance: 0,
        // New campaigns start PAUSED: the advertiser tops up first, then
        // activates. Prevents "accidentally live with empty balance".
        status: 'paused',
      },
    })
    return jsonOk({ id: campaign.id, status: campaign.status }, { status: 201 })
  } catch (err) {
    return handleRouteError(err)
  }
}
