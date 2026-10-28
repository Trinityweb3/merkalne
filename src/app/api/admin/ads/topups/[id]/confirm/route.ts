import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { getSession } from '@/lib/auth'
import { confirmTopUp } from '@/lib/ads/topup'

export const dynamic = 'force-dynamic'

const confirmSchema = z.object({
  /** Optional override when the received amount differs from the expected. */
  receivedCents: z.coerce.number().int().min(1).max(10_000_000).optional(),
})

/**
 * POST /api/admin/ads/topups/[id]/confirm — the OPERATOR path for marking a
 * crypto deposit as received (ADS_TOPUP_MODE=manual, the default). After
 * checking the wallet on-chain (or in the provider console), an admin
 * confirms; the campaign balance is credited exactly once. Optionally the
 * actually-received amount can be passed to credit a partial/over payment.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)
    if (session.user.role !== 'admin') return jsonError('Admin role required', 403)

    const { id } = await ctx.params
    const topUp = await db.cryptoTopUp.findUnique({ where: { id } })
    if (!topUp) return jsonError('Top-up not found', 404)

    const parsed = confirmSchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return jsonError('Invalid confirmation payload', 400, { issues: parsed.error.issues })
    }

    const result = await confirmTopUp(id, { receivedCents: parsed.data.receivedCents })
    if (!result.ok) {
      return jsonError(
        result.reason === 'already_confirmed'
          ? 'This top-up was already confirmed.'
          : 'No campaign to credit.',
        400,
      )
    }
    return jsonOk({
      status: 'confirmed',
      creditedCents: result.creditedCents,
      campaignId: result.campaignId,
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
