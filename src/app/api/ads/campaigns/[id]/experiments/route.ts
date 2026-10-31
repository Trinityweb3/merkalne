import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { canManageCampaigns } from '@/lib/ads/permissions'
import {
  createExperiment,
  experimentStats,
  type ExperimentStats,
} from '@/lib/ads/experiments'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  /** Variant A — an APPROVED creative of this campaign. */
  creativeAId: z.string().min(1).max(64),
  /** Variant B — a DIFFERENT APPROVED creative of this campaign. */
  creativeBId: z.string().min(1).max(64),
  /** The metric the significance test evaluates — "ctr" (the only one today). */
  primaryMetric: z.enum(['ctr']).default('ctr'),
})

/**
 * GET /api/ads/campaigns/[id]/experiments — the "A/B Testing" tab of the
 * campaign details.
 *
 * Returns the campaign's experiments (newest first, every one with its full
 * per-variant statistics: impressions, clicks, CTR, eCPC, assigned visitors
 * and the two-proportion z-test verdict) plus the APPROVED creatives that
 * can be picked for a new test. Campaigns with fewer than two approved
 * creative versions cannot start a test — the payload says so via
 * `canCreateNew` so the UI can render the honest hint.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const { id } = await ctx.params
    const campaign = await db.campaign.findUnique({
      where: { id },
      select: { id: true, advertiserId: true, status: true, deletedAt: true },
    })
    if (!campaign || campaign.advertiserId !== session.user.id) {
      return jsonError('Campaign not found', 404)
    }

    const [experiments, approvedCreatives] = await Promise.all([
      db.experiment.findMany({
        where: { campaignId: campaign.id },
        orderBy: { createdAt: 'desc' },
      }),
      db.creative.findMany({
        where: { campaignId: campaign.id, moderationStatus: 'approved' },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          title: true,
          body: true,
          imageUrl: true,
          altText: true,
          displayDomain: true,
          targetUrl: true,
          createdAt: true,
        },
      }),
    ])

    const stats: ExperimentStats[] = []
    for (const experiment of experiments) {
      stats.push(await experimentStats(experiment))
    }

    const hasLiveExperiment = experiments.some(
      (e) => e.status === 'draft' || e.status === 'running',
    )

    return jsonOk({
      campaignId: campaign.id,
      campaignStatus: campaign.status,
      /** An A/B test needs TWO approved creatives and no live experiment. */
      canCreateNew: approvedCreatives.length >= 2 && !hasLiveExperiment,
      approvedCreatives: approvedCreatives.map((c) => ({
        id: c.id,
        version: c.version,
        title: c.title,
        body: c.body,
        imageUrl: c.imageUrl,
        altText: c.altText,
        displayDomain: c.displayDomain,
        targetUrl: c.targetUrl,
        createdAt: c.createdAt.toISOString(),
      })),
      experiments: stats,
    })
  } catch (err) {
    return handleRouteError(err)
  }
}

/**
 * POST /api/ads/campaigns/[id]/experiments — create a DRAFT A/B test.
 *
 * Rules enforced in src/lib/ads/experiments.ts: exactly two DIFFERENT
 * APPROVED creatives of this campaign, the campaign must be approved
 * (active/paused) and at most one non-finished experiment may exist.
 * The test starts collecting data only when the advertiser starts it
 * (PATCH /api/ads/experiments/[id] { action: "start" }).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    // Phase-4 permission gate: campaign management is OWNER + EDITOR.
    if (!canManageCampaigns(session.user)) {
      return jsonError('Your role does not allow campaign management.', 403, {
        code: 'forbidden_role',
      })
    }

    const rl = rateLimit(`ads-experiment-create:${session.user.id}`, 10, 60_000)
    if (!rl.ok) return jsonError('Too many requests — try again in a minute.', 429)

    const { id } = await ctx.params
    const parsed = createSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError('Invalid experiment', 400, { issues: parsed.error.issues })
    }

    const result = await createExperiment({
      userId: session.user.id,
      campaignId: id,
      creativeAId: parsed.data.creativeAId,
      creativeBId: parsed.data.creativeBId,
      primaryMetric: parsed.data.primaryMetric,
    })
    if (!result.ok) {
      const status =
        result.code === 'campaign_not_found' || result.code === 'not_owner'
          ? 404
          : result.code === 'already_running'
            ? 409
            : 400
      return jsonError(result.message, status, { code: result.code })
    }
    return jsonOk({ id: result.experimentId, status: result.status }, { status: 201 })
  } catch (err) {
    return handleRouteError(err)
  }
}
