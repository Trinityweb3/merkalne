import { db } from '@/lib/db'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonCreated, jsonError, jsonRateLimited } from '@/lib/api'
import { parseJsonBody, reportSchema } from '@/lib/validation'

/**
 * POST /api/posts/[slug]/report — files a moderation report.
 * Available to guests (registration is not required to report abuse). The
 * reason is required; the post and timestamp are attached server-side; the
 * reporter's details are never shown next to the post.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`report:${ip}`, 5, 10 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const body = await parseJsonBody(req, reportSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const { slug } = await ctx.params
    const post = await db.post.findFirst({ where: { slug }, select: { id: true } })
    if (!post) return jsonError('Post not found', 404)

    const report = await db.report.create({
      data: {
        postId: post.id,
        reason: body.data.reason,
        details: body.data.details || null,
        contact: body.data.contact || null,
      },
      select: { id: true },
    })

    return jsonCreated({ reportId: report.id })
  } catch (err) {
    return handleRouteError(err)
  }
}
