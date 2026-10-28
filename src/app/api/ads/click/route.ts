import { z } from 'zod'
import { handleRouteError, jsonOk } from '@/lib/api'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { assertSameOrigin } from '@/lib/csrf'
import { recordClick } from '@/lib/ads/auction'

export const dynamic = 'force-dynamic'

const clickSchema = z.object({ impressionId: z.string().min(1).max(64) })

/**
 * POST /api/ads/click — record that the visitor followed a served ad.
 *
 * Same integrity rules as the stats beacon: same-origin enforcement (a
 * cross-site POST is dropped before the database), per-IP rate limit and
 * one ledger row per impression (the client fires once; the server
 * re-validates that the impression exists and was a view). Clicks are never
 * billed on top of the view — the auction charges per served impression.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req)

    const rl = rateLimit(`ads-click:${clientIp(req)}`, 30, 60_000)
    if (!rl.ok) return jsonOk({ recorded: false })

    const parsed = clickSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return jsonOk({ recorded: false })

    const result = await recordClick(parsed.data.impressionId)
    return jsonOk({ recorded: result.ok })
  } catch (err) {
    return handleRouteError(err)
  }
}
