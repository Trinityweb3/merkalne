import { getSession, toSessionUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { handleRouteError, jsonOk } from '@/lib/api'

/** GET /api/auth/session — current user (or null) for the client chrome. */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return jsonOk({ user: null })

    // Bookmark slugs are needed to hydrate save-buttons on cards.
    const bookmarks = await db.bookmark.findMany({
      where: { userId: session.user.id },
      select: { post: { select: { slug: true } } },
    })

    return jsonOk({
      user: toSessionUser(await db.user.findUniqueOrThrow({ where: { id: session.user.id } })),
      bookmarkedSlugs: bookmarks.map((b) => b.post.slug),
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
