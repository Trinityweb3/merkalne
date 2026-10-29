import { db } from '@/lib/db'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { getSession } from '@/lib/auth'
import { serializeOrder } from '@/lib/premium/orders'

export const dynamic = 'force-dynamic'

/**
 * GET /api/premium/checkout/[id] — status polling for one of the caller's
 * own premium orders (the pricing page pings this every few seconds while a
 * payment is pending). Exposes the payment address, the exact expected
 * amount and the confirmation status; the callbackNonce is deliberately
 * NEVER returned — it is a server-side webhook authenticator.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const { id } = await ctx.params
    const order = await db.premiumOrder.findUnique({ where: { id } })
    if (!order || order.userId !== session.user.id) {
      return jsonError('Order not found', 404)
    }

    // When the order is confirmed the user row carries the new plan state —
    // returned together so the UI (and the session chrome) can refresh in
    // one round-trip instead of a second call.
    const user = order.status === 'confirmed'
      ? await db.user.findUnique({
          where: { id: session.user.id },
          select: { plan: true, premiumUntil: true },
        })
      : null

    return jsonOk({
      ...serializeOrder(order),
      amountReceivedCents: order.amountReceived,
      txHash: order.txHash,
      createdAt: order.createdAt.toISOString(),
      confirmedAt: order.confirmedAt?.toISOString() ?? null,
      ...(user ? { user: { plan: user.plan, premiumUntil: user.premiumUntil?.toISOString() ?? null } } : {}),
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
