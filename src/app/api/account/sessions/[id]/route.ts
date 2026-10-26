import { getSession, revokeSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { handleRouteError, jsonOk, unauthorized } from '@/lib/api'

/** DELETE /api/account/sessions/[id] — revokes one session by id. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) throw unauthorized()
    const { id } = await ctx.params
    const ok = await revokeSession(session.user.id, id)
    return jsonOk({ revoked: ok })
  } catch (err) {
    return handleRouteError(err)
  }
}
