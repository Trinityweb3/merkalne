import { db } from '@/lib/db'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonOk, jsonRateLimited } from '@/lib/api'

/**
 * POST /api/posts/[slug]/view — increments the view counter with
 * de-duplication: one count per post per visitor per 12h window (cookie
 * based) plus per-IP rate limiting to blunt obvious bots/refresh spam.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params
    const post = await db.post.findFirst({ where: { slug, status: 'published' }, select: { id: true } })
    if (!post) return jsonOk({ counted: false })

    const ip = clientIp(req)
    const rl = rateLimit(`view:${ip}`, 60, 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    // Cookie de-dup (route handlers may set cookies).
    const cookieName = `mv_${post.id}`
    const cookieHeader = req.headers.get('cookie') ?? ''
    const seen = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .some((c) => c.startsWith(`${cookieName}=`))

    if (seen) return jsonOk({ counted: false })

    await db.post.update({
      where: { id: post.id },
      data: { views: { increment: 1 } },
    })

    const res = jsonOk({ counted: true })
    res.headers.append(
      'Set-Cookie',
      `${cookieName}=1; Path=/; Max-Age=43200; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    )
    return res
  } catch (err) {
    return handleRouteError(err)
  }
}
