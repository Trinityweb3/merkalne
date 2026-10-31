import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { getSession } from '@/lib/auth'
import { confirmTopUp } from '@/lib/ads/topup'
import { canAdjustBalance } from '@/lib/ads/permissions'
import { logAdminAction } from '@/lib/ads/audit'

export const dynamic = 'force-dynamic'

const confirmSchema = z.object({
  /** Optional override when the received amount differs from the expected. */
  receivedCents: z.coerce.number().int().min(1).max(10_000_000).optional(),
})

/**
 * POST /api/admin/ads/topups/[id]/confirm — the OPERATOR path for marking a
 * crypto deposit as received (ADS_TOPUP_MODE=manual, the default). After
 * checking the wallet on-chain (or in the provider console), an admin
 * confirms; the advertiser's ad wallet is credited exactly once. Optionally
 * the actually-received amount can be passed to credit a partial/over
 * payment.
 *
 * Phase 4: this is a BALANCE ADJUSTMENT — the granular permission gate is
 * OWNER + BILLING (admins default to owner, so existing operators keep
 * working unchanged), and every confirmation lands in the AuditLog with the
 * credited amount as the reason string.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)
    if (session.user.role !== 'admin') return jsonError('Admin role required', 403)
    // Phase-4 granular tier: balance administration is OWNER + BILLING.
    if (!canAdjustBalance(session.user)) {
      return jsonError('Your role does not allow balance adjustments.', 403, {
        code: 'forbidden_role',
      })
    }

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
          : 'Top-up not found.',
        400,
      )
    }

    // Phase 4 — the audit trail: who credited whom, and how much. The
    // credited amount rides in the reason string (the AuditLog carries the
    // actor / action / target / reason, exactly the spec's shape).
    const credited = result.creditedCents ?? 0
    await logAdminAction({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: 'ADJUST_BALANCE',
      targetId: topUp.advertiserId,
      reason: `Ad wallet credited $${(credited / 100).toFixed(2)} (manual deposit confirm, top-up ${id})`,
    })

    return jsonOk({
      status: 'confirmed',
      creditedCents: credited,
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
