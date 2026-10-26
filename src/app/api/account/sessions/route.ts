import { getSession, listSessions, revokeAllOtherSessions } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { handleRouteError, jsonOk, unauthorized } from '@/lib/api'

/** GET /api/account/sessions — lists active sessions for the Security page. */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) throw unauthorized()
    const sessions = await listSessions(session.user.id, session.sessionId)
    // Never expose the token hashes to the client.
    return jsonOk({
      sessions: sessions.map(({ tokenHash: _t, ...rest }) => rest),
    })
  } catch (err) {
    return handleRouteError(err)
  }
}

/** DELETE /api/account/sessions — revokes every session except the current one. */
export async function DELETE(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) throw unauthorized()
    const count = await revokeAllOtherSessions(session.user.id, session.sessionId)
    return jsonOk({ revoked: count })
  } catch (err) {
    return handleRouteError(err)
  }
}
