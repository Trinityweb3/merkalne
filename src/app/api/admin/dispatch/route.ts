import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { dispatchPendingPosts, retryFailedNotifications } from '@/lib/bots/dispatch'
import { ingestFeedUrls } from '@/lib/bots/config'

/**
 * Admin control surface for the bots pipeline (used by /alerts and ops).
 *
 *   POST → run one dispatch + retry pass immediately (instead of waiting for
 *          the next worker tick) — e.g. right after publishing a hot job.
 *   GET  → pipeline status: undispatched posts, premium subscribers,
 *          recent NotificationLog rows and IngestionLog audit trail.
 *
 * Session-authenticated, admin-role only, CSRF-guarded like every browser
 * mutation. The worker does the same work on its interval — this route exists
 * so admins never have to SSH into the worker container for a manual push.
 */

export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)
    if (session.user.role !== 'admin') return jsonError('Admin role required', 403)

    const rl = rateLimit(`admin-dispatch:${session.user.id}`, 6, 60_000)
    if (!rl.ok) return jsonError('Too many manual dispatches — the worker will catch up.', 429)

    const dispatch = await dispatchPendingPosts()
    const retry = await retryFailedNotifications()

    return jsonOk({ dispatch, retry })
  } catch (err) {
    return handleRouteError(err)
  }
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)
    if (session.user.role !== 'admin') return jsonError('Admin role required', 403)

    const [undispatched, premium, notifications, ingestion, feeds] = await Promise.all([
      db.post.count({ where: { status: 'published', notifiedAt: null } }),
      db.user.count({ where: { plan: 'premium', OR: [{ premiumUntil: null }, { premiumUntil: { gt: new Date() } }] } }),
      db.notificationLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true, channel: true, recipient: true, status: true,
          attempts: true, error: true, createdAt: true, sentAt: true,
          post: { select: { slug: true, title: true } },
        },
      }),
      db.ingestionLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, source: true, action: true, ok: true, detail: true, createdAt: true },
      }),
      Promise.resolve(ingestFeedUrls()),
    ])

    return jsonOk({ undispatched, premium, notifications, ingestion, feeds })
  } catch (err) {
    return handleRouteError(err)
  }
}
