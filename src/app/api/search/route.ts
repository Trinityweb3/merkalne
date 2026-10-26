import { db } from '@/lib/db'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { handleRouteError, jsonError, jsonOk, jsonRateLimited } from '@/lib/api'
import { searchQuerySchema } from '@/lib/validation'
import { serializePost } from '@/lib/posts'
import { Prisma } from '@prisma/client'
import { env } from '@/lib/env'

/**
 * GET /api/search — editorial search (Blog is excluded by design).
 * Results are ordered by publishedAt DESC (newest first) with numbered
 * pagination, 10 per page — mirroring the product's search contract.
 * Search terms are AND-ed; each term matches title/body/company/stack/tags
 * case-insensitively. Snippets are generated around the first match and
 * terms are highlighted client-side via <mark>.
 */
export async function GET(req: Request) {
  try {
    const ip = clientIp(req)
    const rl = rateLimit(`search:${ip}`, 60, 60_000)
    if (!rl.ok) return jsonRateLimited(rl.retryAfterSeconds)

    const url = new URL(req.url)
    const parsed = searchQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
    if (!parsed.success) return jsonError('Invalid search parameters', 422)
    const { q, page, section } = parsed.data

    const where: Prisma.PostWhereInput = {
      status: 'published',
      section: section ?? { not: 'blog' },
    }

    const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 8)
    if (terms.length > 0) {
      const insensitive = (field: string, value: string): Record<string, unknown> =>
        env.DATABASE_PROVIDER === 'sqlite'
          ? { [field]: { contains: value } }
          : { [field]: { contains: value, mode: 'insensitive' as const } }

      // Hashtag terms (#tag) switch to exact tag matching — "#Front" never
      // matches "#Frontend" (tags are stored delimiter-separated).
      const tagTerm = terms.find((t) => t.startsWith('#') && t.length > 1)
      const textTerms = terms.filter((t) => t !== tagTerm)

      const termFilters: Prisma.PostWhereInput[] = textTerms.map((term) => ({
        OR: [
          insensitive('title', term),
          insensitive('body', term),
          insensitive('company', term),
          insensitive('stack', term),
          insensitive('tags', term),
        ],
      }))

      if (tagTerm) {
        const tag = tagTerm.slice(1).toLowerCase()
        termFilters.push({
          OR: [
            { tags: tag },
            { tags: { startsWith: `${tag},` } },
            { tags: { contains: `,${tag},` } },
            { tags: { endsWith: `,${tag}` } },
          ],
        })
      }

      where.AND = termFilters
    }

    const pageSize = 10
    const [total, posts] = await Promise.all([
      db.post.count({ where }),
      db.post.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          slug: true,
          section: true,
          kind: true,
          title: true,
          company: true,
          body: true,
          tags: true,
          publishedAt: true,
          views: true,
        },
      }),
    ])

    return jsonOk({
      q,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      results: posts.map((p) => serializePost(p as never)),
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
