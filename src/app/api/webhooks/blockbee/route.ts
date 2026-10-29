/**
 * POST/GET /api/webhooks/blockbee — BlockBee IPN (payment notifications) and
 * payout webhooks, in one endpoint.
 *
 * PAYMENT IPNs (custom payment flow): BlockBee calls back the callback_url
 * registered at intention time, which embeds `order_id` (our own id) and an
 * unguessable `nonce` — both echoed back verbatim. The order_id PREFIX
 * routes the IPN to its domain:
 *   • prem_m_/prem_y_/premplus_m_/premplus_y_ → Premium subscription
 *     checkout (PremiumOrder) — on confirmation the user's plan and
 *     premiumUntil are extended exactly once.
 *   • anything else → Ads wallet top-up (CryptoTopUp) — the campaign wallet
 *     is credited and the advertiser's referrer earns a 50% commission.
 * Two webhook types per payment: pending=1 (payment seen in mempool —
 * snapshotted, no credit) and pending=0 (confirmed on-chain).
 *
 * PAYOUT WEBHOOKS (configured per profile in the BlockBee dashboard): fired
 * when a payout reaches a terminal state (done | error | expired). On done
 * the user's referralBalance is finally deducted — never before.
 *
 * Security layers (in order):
 *   1. per-IP rate limit (spam / DoS)
 *   2. signature verification — RSA-SHA256 via the x-ca-signature header
 *      (BlockBee's production scheme, verified against the processor's
 *      public key) OR HMAC-SHA256 via the `token` param keyed with
 *      BLOCKBEE_IPN_SECRET. At least one must verify.
 *   3. order_id must resolve to a PENDING BlockBee intention in our DB
 *      (PremiumOrder for prem_/premplus_ ids, CryptoTopUp otherwise)
 *   4. the per-intention nonce must match (constant-time)
 *   5. every event — accepted or rejected — lands in PaymentLog
 *
 * ACK protocol: payment IPNs expect the literal body "*ok*" with HTTP 200;
 * payout webhooks only look at the status code. Anything we ACK will not be
 * retried; signature failures are NOT ACKed (401) so genuine transient
 * failures eventually retry, while forgeries just bounce.
 */
import { db } from '@/lib/db'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { timingSafeEqualStr } from '@/lib/csrf'
import { logPayment } from '@/lib/payment-log'
import { confirmTopUp } from '@/lib/ads/topup'
import { ipnUsdCents, reconstructPublicUrl, sanitiseWebhookPayload, verifyWebhookSignature } from '@/lib/ads/blockbee'
import { confirmPremiumOrder, logPremiumPayment } from '@/lib/premium/orders'
import { isPremiumOrderId } from '@/lib/premium/plan'

export const dynamic = 'force-dynamic'

/** BlockBee expects this literal acknowledgement for payment IPNs. */
function ack(): Response {
  return new Response('*ok*', { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

function reject(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain' } })
}

interface ParsedWebhook {
  /** All parameters (query for GET; parsed body for POST) */
  params: URLSearchParams
  /** The raw string the signature was computed over (full URL / raw body) */
  signedData: string
  /** Raw query/body INCLUDING the token param (HMAC canonical base) */
  rawWithToken: string
}

async function parseWebhook(req: Request): Promise<ParsedWebhook | null> {
  if (req.method === 'GET') {
    const url = new URL(req.url)
    return {
      params: url.searchParams,
      signedData: reconstructPublicUrl(req),
      rawWithToken: url.search.startsWith('?') ? url.search.slice(1) : url.search,
    }
  }

  const contentType = req.headers.get('content-type') ?? ''
  const raw = await req.text()
  if (raw.length > 64_000) return null // payload ceiling — BlockBee sends < 2 KB

  if (contentType.includes('application/json')) {
    // json=1 callbacks (not requested by us, but accepted defensively)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        params.set(k, String(v))
      }
    }
    return { params, signedData: raw, rawWithToken: raw }
  }

  // Default: application/x-www-form-urlencoded (payout webhook default)
  return { params: new URLSearchParams(raw), signedData: raw, rawWithToken: raw }
}

export async function GET(req: Request) {
  return handle(req)
}

export async function POST(req: Request) {
  return handle(req)
}

async function handle(req: Request): Promise<Response> {
  // 1. Rate limit — the webhook is a public, cookie-less endpoint; keep
  //    spam and IP-rotating floods cheap to absorb.
  const rl = rateLimit(`blockbee-wh:${clientIp(req)}`, 60, 60_000)
  if (!rl.ok) {
    return reject(429, 'rate limited')
  }

  const parsed = await parseWebhook(req)
  if (!parsed) {
    await logPayment({
      source: 'blockbee_ipn',
      event: 'rejected',
      ok: false,
      detail: { reason: 'malformed_payload' },
    })
    return reject(400, 'malformed payload')
  }
  const { params, signedData, rawWithToken } = parsed

  // 2. Signature verification (RSA x-ca-signature and/or HMAC token).
  const verification = await verifyWebhookSignature({
    method: req.method === 'GET' ? 'GET' : 'POST',
    signedData,
    rsaSignature: req.headers.get('x-ca-signature'),
    hmacToken: params.get('token'),
    rawWithToken,
  })
  if (!verification.ok) {
    await logPayment({
      source: params.has('uuid') ? 'blockbee_ipn' : 'blockbee_payout',
      event: 'rejected',
      ok: false,
      detail: {
        reason: verification.reason,
        payload: sanitiseWebhookPayload(params),
      },
    })
    return reject(401, 'invalid signature')
  }

  // 3. Route by payload shape: payment IPN carries uuid + address_in;
  //    payout webhook carries id + terminal status.
  if (params.has('uuid') && params.has('address_in')) {
    // Payment domains are keyed on the order_id prefix: prem_/premplus_
    // orders belong to the Premium checkout, everything else to Ads top-ups.
    const orderId = params.get('order_id') ?? ''
    if (isPremiumOrderId(orderId)) {
      return handlePremiumIpn(params)
    }
    return handlePaymentIpn(params)
  }
  if (params.has('id') && params.has('status')) {
    return handlePayoutWebhook(params)
  }

  await logPayment({
    source: 'blockbee_ipn',
    event: 'rejected',
    ok: false,
    detail: { reason: 'unrecognised_payload', payload: sanitiseWebhookPayload(params) },
  })
  return reject(400, 'unrecognised payload')
}

// ---------------------------------------------------------------------------
// Payment IPN — Premium / Premium+ subscription orders (prem_/premplus_ ids)
// ---------------------------------------------------------------------------

async function handlePremiumIpn(params: URLSearchParams): Promise<Response> {
  const uuid = params.get('uuid') ?? ''
  const txHash = params.get('txid_in') ?? null
  const orderId = params.get('order_id') ?? ''
  const nonce = params.get('nonce') ?? ''
  const isPending = params.get('pending') === '1'

  // 3a. order_id must resolve to a pending BLOCKBEE premium order in our DB.
  const order = orderId ? await db.premiumOrder.findUnique({ where: { id: orderId } }) : null
  if (!order) {
    await logPremiumPayment({
      event: 'rejected',
      ok: false,
      orderId,
      userId: '',
      externalId: uuid,
      detail: { reason: 'unknown_order', payload: sanitiseWebhookPayload(params) },
    }).catch(() => undefined)
    return ack() // ACK: retrying an unknown order changes nothing
  }
  if (order.provider !== 'blockbee') {
    await logPremiumPayment({
      event: 'rejected',
      ok: false,
      orderId: order.id,
      userId: order.userId,
      externalId: uuid,
      detail: { reason: 'provider_mismatch', provider: order.provider },
    })
    return ack()
  }

  // 3b. Per-intention nonce — binds this webhook to exactly this row.
  if (!order.callbackNonce || !nonce || !timingSafeEqualStr(nonce, order.callbackNonce)) {
    await logPremiumPayment({
      event: 'rejected',
      ok: false,
      orderId: order.id,
      userId: order.userId,
      externalId: uuid,
      detail: { reason: 'nonce_mismatch', payload: sanitiseWebhookPayload(params) },
    })
    return ack()
  }

  // 3c. Only a PENDING order may be activated (idempotency guard).
  if (order.status !== 'pending') {
    await logPremiumPayment({
      event: 'duplicate_ignored',
      ok: true,
      orderId: order.id,
      userId: order.userId,
      externalId: uuid,
      amountCents: order.amountReceived,
    })
    return ack()
  }

  // 4. Snapshot the payment details on the row (audit trail).
  const valueCoin = params.get('value_coin')
  const price = params.get('price')
  await db.premiumOrder
    .update({
      where: { id: order.id },
      data: { uuid, txHash, paidCoinAmount: valueCoin, coinPriceUsd: price },
    })
    .catch(() => undefined)

  if (isPending) {
    await logPremiumPayment({
      event: 'pending_detected',
      ok: true,
      orderId: order.id,
      userId: order.userId,
      externalId: uuid,
      detail: { txHash, valueCoin },
    })
    return ack()
  }

  // Confirmed payment → extend the subscription (exactly once). A confirmed
  // payment below the underpayment tolerance does NOT activate — logged for
  // the operator, order stays pending for a possible follow-up payment.
  const { cents, basis } = ipnUsdCents(params, order.amountExpected)
  const result = await confirmPremiumOrder(order.id, { receivedCents: cents, txHash, uuid })

  if (!result.ok) {
    await logPremiumPayment({
      event: 'credit_skipped',
      ok: false,
      orderId: order.id,
      userId: order.userId,
      externalId: uuid,
      amountCents: cents,
    })
    return ack()
  }

  if (!result.activated) {
    await logPremiumPayment({
      event: result.reason === 'underpaid' ? 'underpaid' : 'duplicate_ignored',
      ok: result.reason !== 'underpaid',
      orderId: order.id,
      userId: order.userId,
      externalId: uuid,
      amountCents: cents,
      detail: { basis, expectedCents: order.amountExpected, txHash },
    })
    return ack()
  }

  await logPremiumPayment({
    event: 'confirmed',
    ok: true,
    orderId: order.id,
    userId: order.userId,
    externalId: uuid,
    amountCents: cents,
    detail: {
      txHash,
      basis,
      plan: result.plan,
      until: result.until.toISOString(),
      receivedCents: result.receivedCents,
      target: 'subscription',
    },
  })
  return ack()
}

// ---------------------------------------------------------------------------
// Payment IPN (ad campaign top-ups)
// ---------------------------------------------------------------------------

async function handlePaymentIpn(params: URLSearchParams): Promise<Response> {
  const uuid = params.get('uuid') ?? ''
  const txHash = params.get('txid_in') ?? null
  const orderId = params.get('order_id') ?? ''
  const nonce = params.get('nonce') ?? ''
  const isPending = params.get('pending') === '1'

  // 3a. order_id must resolve to a pending BLOCKBEE intention in our DB.
  const topUp = orderId ? await db.cryptoTopUp.findUnique({ where: { id: orderId } }) : null
  if (!topUp) {
    await logPayment({
      source: 'blockbee_ipn',
      event: 'rejected',
      ok: false,
      externalId: uuid,
      detail: { reason: 'unknown_order', payload: sanitiseWebhookPayload(params) },
    })
    return ack() // ACK: retrying an unknown order changes nothing
  }
  if (topUp.provider !== 'blockbee') {
    await logPayment({
      source: 'blockbee_ipn',
      event: 'rejected',
      ok: false,
      externalId: uuid,
      referenceId: topUp.id,
      userId: topUp.advertiserId,
      detail: { reason: 'provider_mismatch', provider: topUp.provider },
    })
    return ack()
  }

  // 3b. Per-intention nonce — binds this webhook to exactly this row.
  if (!topUp.callbackNonce || !nonce || !timingSafeEqualStr(nonce, topUp.callbackNonce)) {
    await logPayment({
      source: 'blockbee_ipn',
      event: 'rejected',
      ok: false,
      externalId: uuid,
      referenceId: topUp.id,
      userId: topUp.advertiserId,
      detail: { reason: 'nonce_mismatch', payload: sanitiseWebhookPayload(params) },
    })
    return ack()
  }

  // 3c. Only a PENDING intention may be credited (idempotency guard).
  if (topUp.status !== 'pending') {
    await logPayment({
      source: 'blockbee_ipn',
      event: 'duplicate_ignored',
      ok: true,
      externalId: uuid,
      referenceId: topUp.id,
      userId: topUp.advertiserId,
      amountCents: topUp.amountReceived,
    })
    return ack()
  }

  // 4. Snapshot the payment details on the row (audit trail).
  const valueCoin = params.get('value_coin')
  const price = params.get('price')
  await db.cryptoTopUp
    .update({
      where: { id: topUp.id },
      data: { uuid, txHash, paidCoinAmount: valueCoin, coinPriceUsd: price },
    })
    .catch(() => undefined)

  if (isPending) {
    await logPayment({
      source: 'blockbee_ipn',
      event: 'pending_detected',
      ok: true,
      externalId: uuid,
      referenceId: topUp.id,
      userId: topUp.advertiserId,
      detail: { txHash, valueCoin },
    })
    return ack()
  }

  // Confirmed payment → credit the campaign (exactly once) + referral
  // commission (same transaction, therefore also exactly once).
  const { cents, basis } = ipnUsdCents(params, topUp.amountExpected)
  const result = await confirmTopUp(topUp.id, {
    receivedCents: cents,
    source: 'blockbee',
    txHash,
    uuid,
  })

  if (!result.ok) {
    await logPayment({
      source: 'blockbee_ipn',
      event: 'credit_skipped',
      ok: false,
      externalId: uuid,
      referenceId: topUp.id,
      userId: topUp.advertiserId,
      amountCents: cents,
    })
    return ack()
  }

  await logPayment({
    source: 'blockbee_ipn',
    event: 'confirmed',
    ok: true,
    externalId: uuid,
    referenceId: topUp.id,
    userId: topUp.advertiserId,
    amountCents: cents,
    detail: {
      txHash,
      basis,
      creditedCents: result.creditedCents,
      target: 'wallet',
      referral: result.referral,
    },
  })
  return ack()
}

// ---------------------------------------------------------------------------
// Payout webhook (referral withdrawals)
// ---------------------------------------------------------------------------

const PAYOUT_TEST_SENTINEL = '00000000-0000-0000-0000-000000000000'

async function handlePayoutWebhook(params: URLSearchParams): Promise<Response> {
  const payoutId = params.get('id') ?? ''
  const status = params.get('status') ?? ''
  const error = params.get('error') ?? ''

  // Dashboard "Send test" probe — verify, ACK, touch nothing.
  if (payoutId === PAYOUT_TEST_SENTINEL) {
    await logPayment({ source: 'blockbee_payout', event: 'test_probe', ok: true, externalId: payoutId })
    return ack()
  }

  const withdrawal = await db.referralWithdrawal.findUnique({ where: { payoutId } })
  if (!withdrawal) {
    // Not ours (e.g. an operator-initiated payout from the dashboard).
    await logPayment({
      source: 'blockbee_payout',
      event: 'unknown_payout',
      ok: true,
      externalId: payoutId,
      detail: { status, payload: sanitiseWebhookPayload(params) },
    })
    return ack()
  }

  if (status === 'done') {
    // Atomic flip pending/processing → done: the first webhook to arrive
    // performs the deduction, retries are no-ops.
    const flipped = await db.referralWithdrawal.updateMany({
      where: { id: withdrawal.id, status: { in: ['pending', 'processing'] } },
      data: { status: 'done', completedAt: new Date(), error: null },
    })
    if (flipped.count !== 1) {
      await logPayment({
        source: 'blockbee_payout',
        event: 'duplicate_ignored',
        ok: true,
        externalId: payoutId,
        referenceId: withdrawal.id,
        userId: withdrawal.userId,
      })
      return ack()
    }

    // Deduct ONLY now that BlockBee confirmed the payout on-chain. The gte
    // guard makes the decrement atomic against the balance itself — a race
    // can never drive referralBalance negative.
    const deducted = await db.user.updateMany({
      where: { id: withdrawal.userId, referralBalance: { gte: withdrawal.amountCents } },
      data: { referralBalance: { decrement: withdrawal.amountCents } },
    })
    if (deducted.count !== 1) {
      // Payout settled but the balance no longer covers it — theoretically
      // impossible (single-active-withdrawal guard); flag loudly for the
      // operator instead of silently corrupting the ledger.
      await db.referralWithdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: 'underfunded',
          error: 'Payout settled but referralBalance was insufficient at deduction time',
        },
      })
      await logPayment({
        source: 'blockbee_payout',
        event: 'underfunded',
        ok: false,
        externalId: payoutId,
        referenceId: withdrawal.id,
        userId: withdrawal.userId,
        amountCents: withdrawal.amountCents,
      })
      return ack()
    }

    await logPayment({
      source: 'blockbee_payout',
      event: 'done',
      ok: true,
      externalId: payoutId,
      referenceId: withdrawal.id,
      userId: withdrawal.userId,
      amountCents: withdrawal.amountCents,
      detail: { coin: withdrawal.coin, address: withdrawal.address },
    })
    return ack()
  }

  if (status === 'error' || status === 'expired' || status === 'rejected') {
    // Terminal failure: NO deduction — the user keeps their balance. Per
    // BlockBee docs no funds left the wallet for expired/rejected, and
    // error payouts are recoverable by the operator via payout/process.
    const failedStatus = status === 'expired' ? 'expired' : 'failed'
    const flipped = await db.referralWithdrawal.updateMany({
      where: { id: withdrawal.id, status: { in: ['pending', 'processing'] } },
      data: { status: failedStatus, error: error || `BlockBee payout ${status}` },
    })
    await logPayment({
      source: 'blockbee_payout',
      event: failedStatus,
      ok: false,
      externalId: payoutId,
      referenceId: withdrawal.id,
      userId: withdrawal.userId,
      amountCents: withdrawal.amountCents,
      detail: { error: error.slice(0, 300), flipped: flipped.count === 1 },
    })
    return ack()
  }

  // Non-terminal statuses (should not arrive via webhook) — log and ACK.
  await logPayment({
    source: 'blockbee_payout',
    event: 'status_ignored',
    ok: true,
    externalId: payoutId,
    referenceId: withdrawal.id,
    userId: withdrawal.userId,
    detail: { status },
  })
  return ack()
}
