import 'server-only'
import { Prisma, PrismaClient } from '@prisma/client'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { normalizeTag, parseTags } from '@/lib/utils'
import type { PostListQuery } from '@/lib/validation'

/**
 * Post queries shared by server components and API routes.
 *
 * Case-insensitive `contains` is provider-specific (ILIKE vs LIKE), so the
 * helper below adapts to the configured provider. SQLite's LIKE is already
 * ASCII-case-insensitive, which is exactly what we need for previews.
 */

type PostWhere = Prisma.PostWhereInput

function insensitive(field: string, value: string): Record<string, unknown> {
  if (env.DATABASE_PROVIDER === 'sqlite') {
    return { [field]: { contains: value } }
  }
  return { [field]: { contains: value, mode: 'insensitive' as const } }
}

export function postListWhere(query: Partial<PostListQuery> & { q?: string; tag?: string; authorId?: string; status?: string }): PostWhere {
  const where: PostWhere = {}

  // Visibility: public surfaces only ever see published posts. Authors/admins
  // pass an explicit status for their own management screens.
  if (!query.status || query.status === 'published') {
    where.status = 'published'
  } else if (query.status !== 'all') {
    where.status = query.status
  }

  if (query.section) where.section = query.section
  if (query.authorId) where.authorId = query.authorId

  if (query.kind) where.kind = query.kind
  if (query.workplace) where.workplace = query.workplace
  if (query.employment) where.employment = query.employment
  if (query.level) where.level = query.level

  if (query.tag) {
    // Exact tag matching: "#Front" must never match "#Frontend". Tags are
    // stored normalised as "crypto,trading" so we match on delimiter-bounded
    // fragments. SQLite/Postgres both see the same semantics.
    const tag = normalizeTag(query.tag)
    where.OR = [
      { tags: tag }, // single tag
      { tags: { startsWith: `${tag},` } },
      { tags: { contains: `,${tag},` } },
      { tags: { endsWith: `,${tag}` } },
    ]
  }

  if (query.q && query.q.trim().length > 0) {
    const terms = query.q.trim().split(/\s+/).filter(Boolean).slice(0, 8)
    const termFilters: PostWhere[] = []
    for (const term of terms) {
      termFilters.push({
        OR: [
          insensitive('title', term) as PostWhere,
          insensitive('body', term) as PostWhere,
          insensitive('company', term) as PostWhere,
          insensitive('stack', term) as PostWhere,
          insensitive('tags', term) as PostWhere,
        ] as PostWhere[],
      })
    }
    if (termFilters.length > 0) {
      // AND accepts an array of conditions; merge with any pre-existing ones.
      const existing = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []
      where.AND = [...existing, ...termFilters]
    }
  }

  return where
}

export function postOrderBy(sort: 'newest' | 'oldest' = 'newest') {
  return sort === 'newest'
    ? ([{ publishedAt: 'desc' }, { createdAt: 'desc' }] as Prisma.PostOrderByWithRelationInput[])
    : ([{ publishedAt: 'asc' }, { createdAt: 'asc' }] as Prisma.PostOrderByWithRelationInput[])
}

/** Shape returned to clients — never leaks author email or drafts. */
export const publicPostSelect = {
  id: true,
  slug: true,
  section: true,
  kind: true,
  title: true,
  company: true,
  location: true,
  workplace: true,
  employment: true,
  level: true,
  salary: true,
  stack: true,
  body: true,
  applyUrl: true,
  originalUrl: true,
  tags: true,
  status: true,
  sourceLocale: true,
  translations: true,
  publishedAt: true,
  views: true,
  likeCount: true,
  dislikeCount: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, image: true } },
} satisfies Prisma.PostSelect

export type PublicPost = Prisma.PostGetPayload<{ select: typeof publicPostSelect }>

export async function listPosts(query: PostListQuery) {
  const where = postListWhere(query)
  const [total, posts] = await Promise.all([
    db.post.count({ where }),
    db.post.findMany({
      where,
      select: publicPostSelect,
      orderBy: postOrderBy(query.sort),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ])
  return {
    posts,
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}

/** Latest N published posts for one section (home page rails). */
export async function latestBySection(section: string, take = 3) {
  return db.post.findMany({
    where: { section, status: 'published' },
    select: publicPostSelect,
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take,
  })
}

export async function getPostBySlug(slug: string, opts?: { includeUnpublished?: boolean }) {
  const post = await db.post.findFirst({
    where: { slug, ...(opts?.includeUnpublished ? {} : { status: 'published' }) },
    select: publicPostSelect,
  })
  return post
}

/** Related posts in the same section (sidebar), excluding the current post. */
export async function relatedPosts(post: { id: string; section: string }, take = 3) {
  return db.post.findMany({
    where: { section: post.section, status: 'published', id: { not: post.id } },
    select: publicPostSelect,
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take,
  })
}

export function serializePost(post: PublicPost) {
  // `translations` (the machine-translation cache) is internal — it is never
  // shipped to the client; localized serving happens in server components.
  const { translations: _translations, ...rest } = post
  return {
    ...rest,
    tags: parseTags(post.tags),
    authorName: post.author?.name ?? null,
  }
}

export type SerializedPost = ReturnType<typeof serializePost>

// ---------------------------------------------------------------------------
// Slug uniqueness helper
// ---------------------------------------------------------------------------

export async function uniqueSlug(base: string, prisma: PrismaClient = db): Promise<string> {
  const root = base || 'post'
  let candidate = root
  let suffix = 1
  // Bounded loop; collision probability after a few tries is negligible.
  while (await prisma.post.findUnique({ where: { slug: candidate } })) {
    suffix += 1
    candidate = `${root}-${suffix}`
    if (suffix > 50) {
      candidate = `${root}-${Date.now().toString(36)}`
      break
    }
  }
  return candidate
}
