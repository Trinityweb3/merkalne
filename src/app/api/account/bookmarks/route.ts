import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { publicPostSelect, serializePost } from '@/lib/posts'
import { handleRouteError, jsonOk, unauthorized } from '@/lib/api'

/** GET /api/account/bookmarks — the signed-in user's saved posts. */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) throw unauthorized()

    const items = await db.bookmark.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        createdAt: true,
        post: { select: publicPostSelect },
      },
    })

    return jsonOk({
      items: items.map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        post: serializePost(item.post),
      })),
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
