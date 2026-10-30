import { z } from 'zod'
import { handleRouteError, jsonOk } from '@/lib/api'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { assertSameOrigin } from '@/lib/csrf'
import { finalizeClick } from '@/lib/ads/auction'

export const dynamic = 'force-dynamic'

const clickSchema = z.object({ reservationId: z.string().min(1).max(64) })

/**
 * POST /api/ads/click — the visitor followed a served ad.
 *
 * Same integrity rules as before: same-origin enforcement (a cross-site
 * POST is dropped before the database), per-IP rate limit, and one charge
 * per reservation — the conditional status flip (held → finalized) settles
 * double-fires to a single charge; the unique ledger eventId
 * `charge:<reservationId>` is the second line of defence.
 *
 * CPC: a valid click (reservation still HELD and inside its 30-minute
 * window) finalises the hold and charges the wallet.
 * CPM: the view was already charged at serve time — the beacon is a no-op.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req)

    const rl = rateLimit(`ads-click:${clientIp(req)}`, 30, 60_000)
    if (!rl.ok) return jsonOk({ recorded: false })

    const parsed = clickSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return jsonOk({ recorded: false })

    const result = await finalizeClick(parsed.data.reservationId)
    return jsonOk({ recorded: result.ok, chargedMicroUsd: result.ok ? result.chargedMicroUsd : 0 })
  } catch (err) {
    return handleRouteError(err)
  }
}
