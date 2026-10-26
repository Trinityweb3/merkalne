import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { forbidden, handleRouteError, jsonError, jsonOk, notFound, unauthorized } from '@/lib/api'
import { parseJsonBody, updatePostSchema } from '@/lib/validation'
import { publicPostSelect, serializePost, uniqueSlug } from '@/lib/posts'
import { slugify } from '@/lib/utils'

/** GET /api/posts/[slug] — public post detail by slug. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params
    const post = await db.post.findFirst({
      where: { slug, status: 'published' },
      select: publicPostSelect,
    })
    if (!post) throw notFound('Post not found')
    return jsonOk({ post: serializePost(post) })
  } catch (err) {
    return handleRouteError(err)
  }
}

/** PUT /api/posts/[slug] — edits a post (author or admin only). */
export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    await assertMutationSafe(req)

    const ip = clientIp(req)
    const rl = rateLimit(`post-update:${ip}`, 20, 10 * 60_000)
    if (!rl.ok) return jsonError('Too many requests', 429)

    const session = await getSession()
    if (!session) throw unauthorized()
    const { slug } = await ctx.params

    const existing = await db.post.findUnique({ where: { slug } })
    if (!existing) throw notFound('Post not found')

    const isOwner = existing.authorId === session.user.id
    const isAdmin = session.user.role === 'admin'
    if (!isOwner && !isAdmin) throw forbidden('You can only edit your own posts')

    const body = await parseJsonBody(req, updatePostSchema)
    if (!body.ok) return jsonError(body.message, 422, { issues: body.issues })

    const d = body.data
    const statusChanged = d.status && d.status !== existing.status
    const nowPublishing = statusChanged && d.status === 'published' && !existing.publishedAt

    const updated = await db.post.update({
      where: { id: existing.id },
      data: {
        ...(d.title !== undefined
          ? { title: d.title, slug: d.title !== existing.title ? await uniqueSlug(slugify(d.title)) : existing.slug }
          : {}),
        ...(d.section !== undefined ? { section: d.section } : {}),
        ...(d.kind !== undefined ? { kind: d.kind || null } : {}),
        ...(d.company !== undefined ? { company: d.company || null } : {}),
        ...(d.location !== undefined ? { location: d.location || null } : {}),
        ...(d.workplace !== undefined ? { workplace: d.workplace || null } : {}),
        ...(d.employment !== undefined ? { employment: d.employment || null } : {}),
        ...(d.level !== undefined ? { level: d.level || null } : {}),
        ...(d.salary !== undefined ? { salary: d.salary || null } : {}),
        ...(d.stack !== undefined ? { stack: d.stack || null } : {}),
        ...(d.body !== undefined ? { body: d.body } : {}),
        ...(d.applyUrl !== undefined ? { applyUrl: d.applyUrl || null } : {}),
        ...(d.originalUrl !== undefined ? { originalUrl: d.originalUrl || null } : {}),
        ...(d.tags !== undefined ? { tags: (d.tags ?? []).map((t) => t.toLowerCase()).join(',') } : {}),
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(nowPublishing ? { publishedAt: new Date() } : {}),
      },
      select: publicPostSelect,
    })

    return jsonOk({ post: serializePost(updated) })
  } catch (err) {
    return handleRouteError(err)
  }
}

/** DELETE /api/posts/[slug] — soft-deletes a post (author or admin only). */
export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) throw unauthorized()
    const { slug } = await ctx.params

    const existing = await db.post.findUnique({ where: { slug } })
    if (!existing) throw notFound('Post not found')

    const isOwner = existing.authorId === session.user.id
    const isAdmin = session.user.role === 'admin'
    if (!isOwner && !isAdmin) throw forbidden('You can only delete your own posts')

    await db.post.update({ where: { id: existing.id }, data: { status: 'deleted' } })
    return jsonOk({ deleted: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
