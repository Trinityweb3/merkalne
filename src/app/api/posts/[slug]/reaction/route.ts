import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited, unauthorized } from '@/lib/api'
import { parseJsonBody, reactionSchema } from '@/lib/validation'

/**
 * POST /api/posts/[slug]/reaction — sets, replaces or clears the caller's
 * reaction. The client sends the desired end-state ("none" to clear), so a
 * retried request cannot accidentally flip the vote. Denormalised counters
 * are updated in the same transaction as the unique (postId, userId) row,
 * which makes double-voting impossible.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`reaction:${ip}`, 30, 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const session = await getSession()
    if (!session) throw unauthorized('Sign in to react to posts')

    const body = await parseJsonBody(req, reactionSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const { slug } = await ctx.params
    const post = await db.post.findFirst({ where: { slug }, select: { id: true } })
    if (!post) return jsonError('Post not found', 404)

    const desired = body.data.value
    const existing = await db.reaction.findUnique({
      where: { postId_userId: { postId: post.id, userId: session.user.id } },
    })

    const result = await db.$transaction(async (tx) => {
      if (desired === 'none') {
        if (existing) {
          await tx.reaction.delete({ where: { id: existing.id } })
          await tx.post.update({
            where: { id: post.id },
            data:
              existing.value === 'like'
                ? { likeCount: { decrement: 1 } }
                : { dislikeCount: { decrement: 1 } },
          })
        }
      } else if (!existing) {
        await tx.reaction.create({
          data: { postId: post.id, userId: session.user.id, value: desired },
        })
        await tx.post.update({
          where: { id: post.id },
          data: desired === 'like' ? { likeCount: { increment: 1 } } : { dislikeCount: { increment: 1 } },
        })
      } else if (existing.value !== desired) {
        await tx.reaction.update({ where: { id: existing.id }, data: { value: desired } })
        await tx.post.update({
          where: { id: post.id },
          data:
            desired === 'like'
              ? { likeCount: { increment: 1 }, dislikeCount: { decrement: 1 } }
              : { likeCount: { decrement: 1 }, dislikeCount: { increment: 1 } },
        })
      }

      const fresh = await tx.post.findUniqueOrThrow({
        where: { id: post.id },
        select: { likeCount: true, dislikeCount: true },
      })
      return { yourReaction: desired === 'none' ? null : desired, ...fresh }
    })

    return jsonOk(result)
  } catch (err) {
    return handleRouteError(err)
  }
}
