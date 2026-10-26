import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonCreated, jsonError, jsonOk, jsonRateLimited, forbidden } from '@/lib/api'
import { createPostSchema, parseJsonBody, postListQuerySchema } from '@/lib/validation'
import { listPosts, serializePost, uniqueSlug } from '@/lib/posts'
import { slugify } from '@/lib/utils'
import { SECTION_META } from '@/lib/constants'

/**
 * GET /api/posts — public listing with filters + pagination.
 * `authorId=me` (with an optional `status`) returns the caller's own posts,
 * including drafts — for everyone else only published posts ever leave the
 * API. Blog is excluded from cross-section queries (editorial search rule).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const raw = Object.fromEntries(url.searchParams.entries())
    const parsed = postListQuerySchema.safeParse(raw)
    if (!parsed.success) return jsonError('Invalid query parameters', 422)
    const query = parsed.data

    // Author-scoped view (profile "My posts").
    if (query.authorId === 'me' || (query.status && query.status !== 'published')) {
      const session = await getSession()
      if (!session) return jsonError('Authentication required', 401)

      const isOwner = query.authorId === 'me' || query.authorId === session.user.id
      const isAdmin = session.user.role === 'admin'
      if (!isOwner && !isAdmin) throw forbidden('You can only browse your own posts')

      const result = await listPosts({
        ...query,
        authorId: session.user.id,
        // "all" keeps every status; otherwise the requested one.
        status: query.status === 'all' ? 'all' : query.status ?? 'published',
      })
      return jsonOk({ ...result, posts: result.posts.map(serializePost) })
    }

    const result = await listPosts(query)
    return jsonOk({ ...result, posts: result.posts.map(serializePost) })
  } catch (err) {
    return handleRouteError(err)
  }
}

/**
 * POST /api/posts — creates a post.
 *  * Authenticated users may publish in the Blog section (free tier).
 *  * Publishing in editorial sections requires the admin role (Premium+
 *    quotas arrive with the stage-2 billing integration — see /api/premium).
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`post-create:${ip}`, 10, 10 * 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const session = await getSession()
    if (!session) return jsonError('Sign in to publish posts', 401)

    const body = await parseJsonBody(req, createPostSchema)
    if (!body.ok) return jsonError(body.message, 422, { issues: body.issues })

    const data = body.data
    const isAdmin = session.user.role === 'admin'

    if (data.section !== 'blog' && !isAdmin) {
      throw forbidden(
        `Publishing in ${SECTION_META[data.section].title} requires a Premium+ plan (arriving with stage-2 billing). ` +
          'The community Blog is free for every registered user.',
      )
    }

    const slug = await uniqueSlug(slugify(data.title))
    const post = await db.post.create({
      data: {
        slug,
        section: data.section,
        kind: data.kind ?? null,
        title: data.title,
        company: data.company ?? null,
        location: data.location ?? null,
        workplace: data.workplace ?? null,
        employment: data.employment ?? null,
        level: data.level ?? null,
        salary: data.salary ?? null,
        stack: data.stack ?? null,
        body: data.body,
        applyUrl: data.applyUrl ?? null,
        originalUrl: data.originalUrl ?? null,
        tags: (data.tags ?? []).map((t) => t.toLowerCase()).join(','),
        status: data.status,
        authorId: session.user.id,
        publishedAt: data.status === 'published' ? new Date() : null,
      },
    })

    return jsonCreated({ post: { id: post.id, slug: post.slug, status: post.status, section: post.section } })
  } catch (err) {
    return handleRouteError(err)
  }
}
