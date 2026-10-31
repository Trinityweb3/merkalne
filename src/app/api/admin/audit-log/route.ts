import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'
import { isOwner } from '@/lib/ads/permissions'
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/ads/audit'

export const dynamic = 'force-dynamic'

/** Newest-first page size cap. */
const MAX_TAKE = 100
const DEFAULT_TAKE = 50

/**
 * GET /api/admin/audit-log?action=REJECT_CAMPAIGN&targetId=<id>&take=50 —
 * the Phase-4 accountability view: who approved/rejected which campaign
 * (with the rejection reason the advertiser sees), who adjusted balances,
 * granted premium or changed permission roles — newest first.
 *
 * OWNER-tier admins only (the audit trail is the owners' instrument).
 * Filters are optional; `action` accepts the closed AUDIT_ACTIONS set.
 */
export async function GET(req: Request) {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)
    if (session.user.role !== 'admin') return jsonError('Admin role required', 403)
    if (!isOwner(session.user)) {
      return jsonError('Only owner-tier admins can read the audit log.', 403, {
        code: 'forbidden_role',
      })
    }

    const rl = rateLimit(`admin-audit-log:${clientIp(req)}`, 30, 60_000)
    if (!rl.ok) return jsonError('Too many requests — try again in a minute.', 429)

    const params = new URL(req.url).searchParams
    const rawAction = params.get('action')?.trim().toUpperCase() ?? ''
    const action: AuditAction | undefined = (AUDIT_ACTIONS as readonly string[]).includes(rawAction)
      ? (rawAction as AuditAction)
      : undefined
    const targetId = params.get('targetId')?.trim() || undefined
    const takeRaw = Number.parseInt(params.get('take') ?? '', 10)
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), MAX_TAKE) : DEFAULT_TAKE

    const [rows, total] = await Promise.all([
      db.auditLog.findMany({
        where: {
          ...(action ? { action } : {}),
          ...(targetId ? { targetId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      db.auditLog.count({
        where: {
          ...(action ? { action } : {}),
          ...(targetId ? { targetId } : {}),
        },
      }),
    ])

    return jsonOk({
      total,
      entries: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorLabel: row.actorLabel,
        action: row.action,
        targetId: row.targetId,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
