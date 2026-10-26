import { destroyCurrentSession } from '@/lib/auth'
import { assertMutationSafe } from '@/lib/csrf'
import { handleRouteError, jsonOk } from '@/lib/api'

/** POST /api/auth/logout — destroys the current server-side session. */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    await destroyCurrentSession()
    return jsonOk({ signedOut: true })
  } catch (err) {
    return handleRouteError(err)
  }
}
