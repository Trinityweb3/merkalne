import { db } from '@/lib/db'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { statsEnv } from '@/lib/stats/config'
import {
  countryFromHeaders,
  deriveSection,
  isBotUserAgent,
  isValidTrackPath,
  visitorFingerprint,
} from '@/lib/stats/track'
import { assertSameOrigin, CsrfError } from '@/lib/csrf'

/**
 * POST /api/track — anonymous page-view beacon fired by <StatsBeacon /> on
 * every client-side navigation (and once per first load).
 *
 * Design rules:
 *   * NEVER breaks the page — every skip path and every error is a silent 204.
 *   * Integrity: same-origin enforcement (cross-site POSTs are dropped before
 *     touching the database), per-IP rate limit, per-visitor dedupe window.
 *   * Privacy: no raw IP / user agent / user id is stored — only an
 *     irreversible HMAC fingerprint, the path, a section bucket and a
 *     proxy-header country code. Do-Not-Track requests are not recorded.
 *   * The double-submit CSRF cookie is deliberately NOT required here: the
 *     beacon must work on pages without forms, and the origin check plus
 *     anonymity of the write (a counter, no user state) make forgery
 *     worthless beyond polluting an anonymous count — which the rate limit,
 *     dedupe window and bot filter already blunt.
 */
const EMPTY = new Response(null, { status: 204 })

export async function POST(req: Request) {
  try {
    if (!statsEnv.TRACKING_ENABLED) return EMPTY

    try {
      assertSameOrigin(req)
    } catch (err) {
      if (err instanceof CsrfError) return EMPTY
      throw err
    }

    const ip = clientIp(req)
    const rl = rateLimit(`track:${ip}`, 120, 60_000)
    if (!rl.ok) return EMPTY

    const userAgent = req.headers.get('user-agent') ?? ''
    if (!userAgent || isBotUserAgent(userAgent)) return EMPTY
    if (req.headers.get('dnt') === '1') return EMPTY

    const body = (await req.json().catch(() => null)) as { path?: unknown } | null
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!isValidTrackPath(path)) return EMPTY

    const visitorId = visitorFingerprint(ip, userAgent)
    const cutoff = new Date(Date.now() - statsEnv.TRACK_DEDUPE_MINUTES * 60_000)
    const recent = await db.visit.findFirst({
      where: { visitorId, path, createdAt: { gte: cutoff } },
      select: { id: true },
    })
    if (recent) return EMPTY

    await db.visit.create({
      data: { path, section: deriveSection(path), country: countryFromHeaders(req.headers), visitorId },
    })
    return EMPTY
  } catch (err) {
    // The beacon must never surface errors in the user's console.
    console.error('[track] failed to record visit:', err)
    return EMPTY
  }
}
