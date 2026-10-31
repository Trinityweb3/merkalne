import { z } from 'zod'
import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { ADMIN_ROLES, adminRoleLabel, isOwner } from '@/lib/ads/permissions'
import { logAdminAction } from '@/lib/ads/audit'

export const dynamic = 'force-dynamic'

const setRoleSchema = z.object({
  /** The account whose permission tier changes. */
  userId: z.string().min(1).max(64),
  /** The new tier — one of owner | editor | analyst | billing. */
  adminRole: z.enum(ADMIN_ROLES),
  /** Optional note stored in the AuditLog (why the role changed). */
  reason: z.string().trim().max(300).optional(),
})

/**
 * POST /api/admin/users/role — change a user's Phase-4 permission tier
 * (User.adminRole: OWNER | EDITOR | ANALYST | BILLING).
 *
 * OWNER admins only (the highest tier manages the tiers themselves), admin
 * platform role required, CSRF + rate limited. Every change lands in the
 * AuditLog as SET_ROLE with the old → new tier in the reason.
 *
 * This is the only way a tier ever changes — the default is "owner" for
 * every account (existing and new), so nothing is locked out until an
 * owner deliberately demotes it.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)
    if (session.user.role !== 'admin') return jsonError('Admin role required', 403)
    if (!isOwner(session.user)) {
      return jsonError('Only owner-tier admins can change permission roles.', 403, {
        code: 'forbidden_role',
      })
    }

    const rl = rateLimit(`admin-set-role:${session.user.id}`, 20, 60_000)
    if (!rl.ok) return jsonError('Too many requests — try again in a minute.', 429)

    const parsed = setRoleSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError('Invalid role change', 400, { issues: parsed.error.issues })
    }
    const { userId, adminRole, reason } = parsed.data

    if (userId === session.user.id && adminRole !== 'owner') {
      return jsonError('You cannot demote your own owner tier — ask another owner.', 400, {
        code: 'self_demotion',
      })
    }

    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, adminRole: true },
    })
    if (!target) return jsonError('User not found', 404)
    if (target.adminRole === adminRole) {
      return jsonError(`That account is already ${adminRoleLabel(adminRole)}.`, 400, {
        code: 'unchanged',
      })
    }

    await db.user.update({ where: { id: target.id }, data: { adminRole } })
    await logAdminAction({
      actorId: session.user.id,
      actorLabel: session.user.email,
      action: 'SET_ROLE',
      targetId: target.id,
      reason: `${target.email}: ${adminRoleLabel(target.adminRole)} → ${adminRoleLabel(adminRole)}${reason ? ` — ${reason}` : ''}`,
    })

    return jsonOk({ userId: target.id, adminRole })
  } catch (err) {
    return handleRouteError(err)
  }
}
