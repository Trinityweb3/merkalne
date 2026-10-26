import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { toSessionUser } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { handleRouteError, jsonError, jsonOk, unauthorized } from '@/lib/api'
import { parseJsonBody, updateProfileSchema } from '@/lib/validation'

/** PUT /api/account/profile — updates the public profile fields. */
export async function PUT(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) throw unauthorized()

    const body = await parseJsonBody(req, updateProfileSchema)
    if (!body.ok) return jsonError(body.message, 422)

    const { name, bio, links } = body.data
    const user = await db.user.update({
      where: { id: session.user.id },
      data: {
        ...(name !== undefined ? { name: name || null } : {}),
        ...(bio !== undefined ? { bio: bio || null } : {}),
        ...(links !== undefined ? { links: links.length > 0 ? links.join(', ') : null } : {}),
      },
    })

    return jsonOk({ user: toSessionUser(user) })
  } catch (err) {
    return handleRouteError(err)
  }
}
