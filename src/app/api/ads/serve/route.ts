import { handleRouteError, jsonOk } from '@/lib/api'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { AD_SLOT_IDS, serveAd, type AdSlotId } from '@/lib/ads/auction'
import { AD_SECTION_CONTEXTS, AD_LOCALE_CODES } from '@/lib/ads/targeting'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ads/serve?slot=feed&section=intern-junior&locale=ru — one
 * weighted-random auction pick for a slot, restricted to campaigns whose
 * TARGETING includes the page being served.
 *
 *   slot     required — one of the placement ids (home_banner | feed | article_bottom)
 *   section  optional — slug of the content section ("intern-junior", …) or
 *            "home"; unknown values are ignored (treated as untargeted)
 *   locale   optional — interface locale code ("en", "ru", …)
 *
 * Public (ad delivery must work for anonymous visitors), heavily rate-limited
 * per IP, and ALWAYS a fast 204 when nothing is eligible: the <AdSlot/>
 * component renders nothing on 204, so a sold-out auction leaves no empty
 * boxes on the page.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams
    const slot = params.get('slot') ?? ''
    if (!(AD_SLOT_IDS as readonly string[]).includes(slot)) {
      return jsonOk({ ad: null }, { status: 200 })
    }

    const rl = rateLimit(`ads-serve:${clientIp(req)}`, 30, 60_000)
    if (!rl.ok) return new Response(null, { status: 204 })

    // Serving context — only known slugs/locales are honoured so a crafted
    // query can neither widen nor narrow other advertisers' reach.
    const rawSection = params.get('section')?.trim().toLowerCase() ?? ''
    const rawLocale = params.get('locale')?.trim().toLowerCase() ?? ''
    const section = (AD_SECTION_CONTEXTS as readonly string[]).includes(rawSection)
      ? rawSection
      : undefined
    const locale = (AD_LOCALE_CODES as readonly string[]).includes(rawLocale)
      ? rawLocale
      : undefined

    const ad = await serveAd(slot as AdSlotId, { section, locale })
    if (!ad) return new Response(null, { status: 204 })
    return jsonOk({ ad })
  } catch (err) {
    return handleRouteError(err)
  }
}
