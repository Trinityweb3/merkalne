import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { handleRouteError, jsonOk, unauthorized } from '@/lib/api'

/** GET /api/account/stats — personal counters for the profile overview. */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) throw unauthorized()
    const userId = session.user.id

    const [posts, bookmarks, comments] = await Promise.all([
      db.post.count({ where: { authorId: userId, status: 'published' } }),
      db.bookmark.count({ where: { userId } }),
      db.comment.count({ where: { userId } }),
    ])

    return jsonOk({ posts, bookmarks, comments })
  } catch (err) {
    return handleRouteError(err)
  }
}
