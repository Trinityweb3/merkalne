import { jsonOk, handleRouteError, jsonError } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { computeAndSaveSnapshot } from '@/lib/stats/aggregate'

/**
 * POST /api/admin/stats — recompute today's snapshot right now.
 *
 * The worker computes one snapshot per UTC day automatically
 * (STATS_SNAPSHOT_UTC_HOUR); this route exists so admins can refresh the
 * About page on demand — e.g. right before sharing it with an investor —
 * without waiting for the nightly tick. Idempotent: recomputing replaces
 * today's snapshot with fresh windows.
 *
 * Session-authenticated, admin-role only, CSRF-guarded like every browser
 * mutation.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)
    if (session.user.role !== 'admin') return jsonError('Admin role required', 403)

    const rl = rateLimit(`admin-stats:${session.user.id}`, 6, 60_000)
    if (!rl.ok) return jsonError('Too many snapshot recomputes — try again in a minute.', 429)

    const { date, data } = await computeAndSaveSnapshot(new Date(), 'admin')
    return jsonOk({ asOf: date.toISOString(), snapshot: data })
  } catch (err) {
    return handleRouteError(err)
  }
}
