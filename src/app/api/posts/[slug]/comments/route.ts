import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonCreated, jsonError, jsonOk, jsonRateLimited, unauthorized } from '@/lib/api'
import { commentSchema, parseJsonBody } from '@/lib/validation'

/** GET /api/posts/[slug]/comments — public comment list. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params
    const post = await db.post.findFirst({ where: { slug }, select: { id: true } })
    if (!post) return jsonError('Post not found', 404)

    const comments = await db.comment.findMany({
      where: { postId: post.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: { id: true, name: true, image: true } },
      },
    })
    return jsonOk({ comments })
  } catch (err) {
    return handleRouteError(err)
  }
}

/** POST /api/posts/[slug]/comments — adds a comment (registered users only). */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`comment:${ip}`, 10, 5 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const session = await getSession()
    if (!session) throw unauthorized('Sign in to join the discussion')

    const body = await parseJsonBody(req, commentSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const { slug } = await ctx.params
    const post = await db.post.findFirst({ where: { slug, status: 'published' }, select: { id: true } })
    if (!post) return jsonError('Post not found', 404)

    const comment = await db.comment.create({
      data: { postId: post.id, userId: session.user.id, body: body.data.body },
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: { id: true, name: true, image: true } },
      },
    })

    return jsonCreated({ comment })
  } catch (err) {
    return handleRouteError(err)
  }
}
