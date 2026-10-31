import { handleRouteError, jsonOk } from '@/lib/api'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { AD_SLOT_IDS, serveAd, type AdSlotId } from '@/lib/ads/auction'
import { isKnownBot, visitorStableId } from '@/lib/ads/antifraud'
import {
  AD_SECTION_CONTEXTS,
  AD_LOCALE_CODES,
  HASHTAG_MAX_LEN,
  KEYWORD_MAX_LEN,
} from '@/lib/ads/targeting'

export const dynamic = 'force-dynamic'

/** Context lists are capped the same way the campaign API caps its input. */
const MAX_CTX_KEYWORDS = 20
const MAX_CTX_HASHTAGS = 20

/** Split a comma-separated query param into clean lowercase phrases. */
function splitPhrases(raw: string, maxLen: number, max: number): string[] {
  const out: string[] = []
  for (const part of raw.split(',')) {
    const value = part.trim().toLowerCase().slice(0, maxLen)
    if (!value) continue
    if (!out.includes(value)) out.push(value)
    if (out.length >= max) break
  }
  return out
}

/**
 * GET /api/ads/serve?slot=feed&section=intern-junior&locale=ru — one
 * weighted-random auction pick for a slot, restricted to campaigns whose
 * TARGETING includes the page being served.
 *
 *   slot     required — one of the placement ids (home_banner | feed | article_bottom)
 *   section  optional — slug of the content section ("intern-junior", …) or
 *            "home"; unknown values are ignored (treated as untargeted)
 *   locale   optional — interface locale code ("en", "ru", …)
 *   keywords optional — the page's keyword context, comma separated (the
 *            article pages pass the post title + tags). Keyword-targeted
 *            campaigns match against this (phrase or exact).
 *   hashtags optional — the page's tags, comma separated. Hashtag-targeted
 *            campaigns match these exactly.
 *   country  optional — overrides the visitor country for testing; the
 *            production source is the CF-IPCountry header Cloudflare sets
 *            on every request (ISO 3166-1 alpha-2).
 *
 * Public (ad delivery must work for anonymous visitors), heavily rate-limited
 * per IP, and ALWAYS a fast 204 when nothing is eligible: the <AdSlot/>
 * component renders nothing on 204, so a sold-out auction leaves no empty
 * boxes on the page.
 *
 * Phase 3 anti-fraud: known bots/crawlers (User-Agent) get a 204 BEFORE the
 * auction runs — no BudgetReservation and no loaded_impression row is ever
 * created for them, so nothing a bot does downstream can be billable.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams
    const slot = params.get('slot') ?? ''
    if (!(AD_SLOT_IDS as readonly string[]).includes(slot)) {
      return jsonOk({ ad: null }, { status: 200 })
    }

    // Phase 3 anti-fraud — bots never see (nor hold budget for) an ad.
    const userAgent = req.headers.get('user-agent')
    if (isKnownBot(userAgent)) return new Response(null, { status: 204 })

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

    // Visitor country — the ?country= parameter wins (test/preview), then
    // the CF-IPCountry header Cloudflare attaches to every request. Invalid
    // values mean "unknown": only country-unrestricted campaigns match.
    const rawCountry =
      params.get('country')?.trim() ?? req.headers.get('cf-ipcountry')?.trim() ?? ''
    const country = /^[A-Za-z]{2}$/.test(rawCountry) ? rawCountry.toUpperCase() : undefined

    const rawKeywords = params.get('keywords') ?? ''
    const keywords = rawKeywords ? splitPhrases(rawKeywords, KEYWORD_MAX_LEN, MAX_CTX_KEYWORDS) : []
    const rawHashtags = params.get('hashtags') ?? ''
    const hashtags = rawHashtags ? splitPhrases(rawHashtags, HASHTAG_MAX_LEN, MAX_CTX_HASHTAGS) : []

    const ad = await serveAd(slot as AdSlotId, {
      section,
      locale,
      country,
      keywords: keywords.length > 0 ? keywords : undefined,
      hashtags: hashtags.length > 0 ? hashtags : undefined,
      // Phase 3: feeds the AdEvent anti-fraud/analytics columns on the
      // loaded_impression row (bot filtering already happened above).
      userAgent: userAgent ?? undefined,
      visitorIp: clientIp(req),
      // Phase 4: the STABLE visitor id (salted HMAC of IP + UA, minted
      // server-side). After a campaign with a RUNNING A/B experiment wins
      // the draw, a stable hash of this id picks the variant — the same
      // visitor always sees the same variant. Never client-supplied.
      visitorId: visitorStableId(clientIp(req), userAgent),
    })
    if (!ad) return new Response(null, { status: 204 })
    return jsonOk({ ad })
  } catch (err) {
    return handleRouteError(err)
  }
}
