import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited, unauthorized } from '@/lib/api'

/**
 * POST /api/posts/[slug]/bookmark — toggles a bookmark for the signed-in
 * user. Guests receive 401 so the UI can prompt registration (bookmarks are
 * free for every registered user and sync across devices).
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`bookmark:${ip}`, 40, 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const session = await getSession()
    if (!session) throw unauthorized('Sign in to save posts — it is free and syncs across your devices')

    const { slug } = await ctx.params
    const post = await db.post.findFirst({ where: { slug }, select: { id: true } })
    if (!post) return jsonError('Post not found', 404)

    const existing = await db.bookmark.findUnique({
      where: { postId_userId: { postId: post.id, userId: session.user.id } },
    })

    if (existing) {
      await db.bookmark.delete({ where: { id: existing.id } })
      return jsonOk({ bookmarked: false })
    }

    await db.bookmark.create({ data: { postId: post.id, userId: session.user.id } })
    return jsonOk({ bookmarked: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
