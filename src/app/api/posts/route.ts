import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonCreated, jsonError, jsonOk, jsonRateLimited, forbidden } from '@/lib/api'
import { createPostSchema, parseJsonBody, postListQuerySchema } from '@/lib/validation'
import { listPosts, serializePost, uniqueSlug } from '@/lib/posts'
import { localizePostList } from '@/lib/localize'
import { LOCALES } from '@/i18n/routing'
import { slugify } from '@/lib/utils'
import { SECTION_META } from '@/lib/constants'
import { isPremiumPlusActive } from '@/lib/premium/plan'

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
    // Optional content localization for programmatic/API consumers:
    //   GET /api/posts?section=mid-senior&locale=ru
    // Localized pages do NOT rely on this (server components localize
    // internally); the param exists so API clients get the same translated
    // titles the UI shows.
    const requestedLocale = url.searchParams.get('locale') ?? 'en'
    const locale = (LOCALES as readonly string[]).includes(requestedLocale) ? requestedLocale : 'en'
    const posts = locale === 'en' ? result.posts : await localizePostList(result.posts, locale)
    return jsonOk({ ...result, posts: posts.map(serializePost) })
  } catch (err) {
    return handleRouteError(err)
  }
}

/** Editorial posts a Premium+ author may publish per calendar month. */
const EDITORIAL_MONTHLY_QUOTA = 5

/**
 * POST /api/posts — creates a post.
 *  * Authenticated users may publish in the Blog section (free tier).
 *  * Publishing in EDITORIAL sections requires an ACTIVE Premium+ plan
 *    (5 posts / calendar month) or the admin role. Standard Premium is NOT
 *    enough — the quotas are the Premium+ selling point.
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
      // Premium+ gate — enforced server-side from the session's plan state.
      if (!isPremiumPlusActive(session.user)) {
        throw forbidden(
          `Publishing in ${SECTION_META[data.section].title} requires a Premium+ subscription ` +
            `(merklane.com/premium). Standard Premium unlocks job alerts; the editorial ` +
            'publishing quotas are Premium+. The community Blog is free for every registered user.',
        )
      }
      // Monthly quota (published editorial posts only — drafts stay free).
      if (data.status === 'published') {
        const monthStart = new Date()
        monthStart.setUTCDate(1)
        monthStart.setUTCHours(0, 0, 0, 0)
        const publishedThisMonth = await db.post.count({
          where: {
            authorId: session.user.id,
            section: { not: 'blog' },
            status: 'published',
            publishedAt: { gte: monthStart },
          },
        })
        if (publishedThisMonth >= EDITORIAL_MONTHLY_QUOTA) {
          return jsonError(
            `Editorial quota reached: ${EDITORIAL_MONTHLY_QUOTA} published posts this calendar month ` +
              '(Premium+). Additional slots reset on the 1st — or contact us for team arrangements.',
            403,
            { code: 'editorial_quota_reached' },
          )
        }
      }
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
