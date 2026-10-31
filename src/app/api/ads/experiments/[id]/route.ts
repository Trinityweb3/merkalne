import { z } from 'zod'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { canManageCampaigns } from '@/lib/ads/permissions'
import {
  finishExperiment,
  pauseExperiment,
  startExperiment,
} from '@/lib/ads/experiments'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  /**
   * start  DRAFT → RUNNING — the 50/50 hash split begins (startedAt is set
   *        on the first start and preserved across pauses)
   * pause  RUNNING → DRAFT — the campaign serves its latest approved
   *        creative again; the collected statistics are kept
   * finish DRAFT|RUNNING → FINISHED (terminal) — the test is concluded
   */
  action: z.enum(['start', 'pause', 'finish']),
})

/**
 * PATCH /api/ads/experiments/[id] — control one of the advertiser's own
 * A/B experiments: start / pause / finish. Ownership is verified against
 * the experiment's campaign; the Phase-4 permission gate (OWNER + EDITOR)
 * applies like every other campaign-management action.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    if (!canManageCampaigns(session.user)) {
      return jsonError('Your role does not allow campaign management.', 403, {
        code: 'forbidden_role',
      })
    }

    const rl = rateLimit(`ads-experiment-patch:${session.user.id}`, 20, 60_000)
    if (!rl.ok) return jsonError('Too many updates — try again in a minute.', 429)

    const { id } = await ctx.params
    const parsed = patchSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return jsonError('Invalid action', 400, { issues: parsed.error.issues })

    const input = { userId: session.user.id, experimentId: id }
    const result =
      parsed.data.action === 'start'
        ? await startExperiment(input)
        : parsed.data.action === 'pause'
          ? await pauseExperiment(input)
          : await finishExperiment(input)

    if (!result.ok) {
      const status =
        result.code === 'not_found' || result.code === 'not_owner'
          ? 404
          : result.code === 'already_running'
            ? 409
            : 400
      return jsonError(result.message, status, { code: result.code })
    }
    return jsonOk({ id: result.experimentId, status: result.status })
  } catch (err) {
    return handleRouteError(err)
  }
}
