import { handleRouteError, jsonOk } from '@/lib/api'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { AD_SLOT_IDS, serveAd, type AdSlotId } from '@/lib/ads/auction'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads/serve?slot=home_banner — one weighted-random auction pick for
 * a slot. Public (ad delivery must work for anonymous visitors), heavily
 * rate-limited per IP, and ALWAYS a fast 204 when nothing is eligible: the
 * <AdSlot/> component renders nothing on 204, so a sold-out auction leaves
 * no empty boxes on the page.
 */
export async function GET(req: Request) {
  try {
    const slot = new URL(req.url).searchParams.get('slot') ?? ''
    if (!(AD_SLOT_IDS as readonly string[]).includes(slot)) {
      return jsonOk({ ad: null }, { status: 200 })
    }

    const rl = rateLimit(`ads-serve:${clientIp(req)}`, 30, 60_000)
    if (!rl.ok) return new Response(null, { status: 204 })

    const ad = await serveAd(slot as AdSlotId)
    if (!ad) return new Response(null, { status: 204 })
    return jsonOk({ ad })
  } catch (err) {
    return handleRouteError(err)
  }
}
