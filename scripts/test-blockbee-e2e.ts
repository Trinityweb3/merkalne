/**
 * BlockBee integration — HTTP end-to-end test.
 *
 * Runs a MOCK BlockBee API in-process (real RSA keypair, same endpoints and
 * payload shapes as the production processor) and drives the FULL payment
 * journey against a live dev server (wallet-first ads flow):
 *
 *   wallet deposit intention (coin picker, TRON + unknown coins rejected,
 *   campaign submission with an empty wallet rejected)
 *   → signed pending IPN (RSA x-ca-signature)
 *   → signed confirmed IPN (HMAC token) → ad WALLET credited + referrer's
 *     50% commission landed
 *   → campaign submitted + funded FROM the wallet (Phase 2: PENDING, then
 *     approved so the payment rails can continue)
 *   → duplicate IPN → idempotent (no double credit)
 *   → forged / missing signature → 401 + PaymentLog rejected
 *   → wrong nonce / unknown order → acked but never credited
 *   → referral registration (?ref=CODE → referredBy set)
 *   → withdrawal via the payout chain (convert → request → create → process)
 *     — balance NOT deducted until…
 *   → payout webhook done (RSA over raw body) → deduction, duplicate ignored
 *   → payout webhook error → withdrawal failed, balance untouched
 *   → webhook rate limit → 429
 *
 * Run via: bash scripts/run-blockbee-e2e.sh
 * (spawns the dev server on :3103 with BLOCKBEE_API_BASE=http://127.0.0.1:3199)
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const ORIGIN = (process.env.BASE_URL ?? 'http://localhost:3103').replace(/\/+$/, '')
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 3199)
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const API_KEY = 'test-blockbee-key'
const IPN_SECRET = 'test-blockbee-ipn-secret-0123456789abcdef'

const db = new PrismaClient()

let pass = 0
let fail = 0
function check(ok: boolean, label: string): void {
  if (ok) {
    pass++
    console.log(`  [ok]   ${label}`)
  } else {
    fail++
    console.log(`  [FAIL] ${label}`)
  }
}

const CSRF = crypto.randomBytes(24).toString('base64url')
const SESSION_TOKEN = crypto.randomBytes(32).toString('base64url')
const REFERRER_TOKEN = crypto.randomBytes(32).toString('base64url')

function sha256(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex')
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; auth?: string | null } = {},
): Promise<{ status: number; data: any }> {
  const auth = opts.auth !== undefined ? opts.auth : SESSION_TOKEN
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
  }
  if ((opts.method ?? 'GET') !== 'GET') headers['X-CSRF-Token'] = CSRF
  const cookie: string[] = [`merklane_csrf=${CSRF}`]
  if (auth) cookie.push(`merklane_session=${auth}`)
  headers['Cookie'] = cookie.join('; ')

  const res = await fetch(`${ORIGIN}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  })
  let data: any = null
  try {
    const body = await res.json()
    data = body && typeof body === 'object' && 'data' in body ? body.data : body
  } catch {
    data = null
  }
  return { status: res.status, data }
}

// ---------------------------------------------------------------------------
// Mock BlockBee processor
// ---------------------------------------------------------------------------

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()

const createdIntentions: { coin: string; callback: string; apikey: string; convert: string }[] = []
const payoutRequests: { id: string; coin: string; address: string; value: string }[] = []
const payouts: { id: string; requestIds: string[]; status: string }[] = []

function signRsa(data: string): string {
  return crypto.createSign('RSA-SHA256').update(data, 'utf8').sign(privateKey, 'base64')
}

function hmacToken(canonical: string): string {
  return crypto.createHmac('sha256', IPN_SECRET).update(canonical, 'utf8').digest('hex')
}

function startMock(): Promise<void> {
  return new Promise((resolvePromise) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', MOCK)
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const parts = url.pathname.split('/').filter(Boolean)

      if (req.method === 'GET' && url.pathname === '/pubkey/') {
        return send(200, { status: 'success', pubkey: PUBLIC_PEM })
      }

      if (req.method === 'GET' && url.pathname === '/convert/') {
        const value = Number(url.searchParams.get('value') ?? '0')
        const to = url.searchParams.get('to') ?? ''
        // Fake price: 1 USD = 1 coin unit for stablecoin-ish ticks, else 2.
        const rate = to.includes('usdt') || to.includes('usdc') ? '1' : '2'
        return send(200, {
          status: 'success',
          value_coin: (value * Number(rate)).toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0'),
          exchange_rate: rate,
        })
      }

      // POST /payout/create | /payout/process | /payout/status (form bodies)
      if (req.method === 'POST' && parts[0] === 'payout') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const form = new URLSearchParams(raw)
          if (parts[1] === 'create') {
            const ids = (form.get('request_ids') ?? '').split(',').filter(Boolean)
            const id = crypto.randomUUID()
            payouts.push({ id, requestIds: ids, status: 'created' })
            return send(200, {
              status: 'success',
              payout_info: {
                id,
                status: 'created',
                display_status: 'Created',
                requests: {},
                total_requested: '0',
                total_with_fee: '0',
                error: null,
                txid: '',
                timestamp: '01/01/2026 00:00:00',
              },
            })
          }
          if (parts[1] === 'process') {
            const id = form.get('payout_id') ?? ''
            const p = payouts.find((x) => x.id === id)
            if (!p) return send(400, { status: 'error', error: 'Payout not found' })
            p.status = 'processing'
            return send(200, {
              status: 'success',
              queued: true,
              payout_info: {
                id,
                status: 'processing',
                display_status: 'Pending Payment',
                error: null,
                txid: '',
                timestamp: '01/01/2026 00:00:00',
              },
            })
          }
          if (parts[1] === 'status') {
            const id = form.get('payout_id') ?? ''
            const p = payouts.find((x) => x.id === id)
            if (!p) return send(400, { status: 'error', error: 'Payout not found' })
            return send(200, {
              status: 'success',
              payout_info: { id, status: p.status, display_status: p.status, txid: '', error: null },
            })
          }
          return send(404, { status: 'error', error: 'not found' })
        })
        return
      }

      // GET /{coin}/payout/request/create/
      if (req.method === 'GET' && parts[1] === 'payout' && parts[2] === 'request' && parts[3] === 'create') {
        const id = crypto.randomUUID()
        payoutRequests.push({
          id,
          coin: parts[0],
          address: url.searchParams.get('address') ?? '',
          value: url.searchParams.get('value') ?? '',
        })
        return send(200, { status: 'success', request_id: id })
      }

      // GET /{coin}/create/ — issue a payment address
      if (req.method === 'GET' && parts[1] === 'create') {
        if (url.searchParams.get('apikey') !== API_KEY) {
          return send(403, { status: 'error', error: 'API key incorrect' })
        }
        const callback = url.searchParams.get('callback') ?? ''
        createdIntentions.push({
          coin: parts[0],
          callback,
          apikey: url.searchParams.get('apikey') ?? '',
          convert: url.searchParams.get('convert') ?? '',
        })
        const addressIn = `MOCK${crypto.createHash('sha256').update(callback).digest('hex').slice(0, 34)}`
        return send(200, {
          status: 'success',
          address_in: addressIn,
          address_out: 'MOCKPAYOUTADDR',
          callback_url: callback,
          priority: 'default',
          minimum_transaction_coin: 0.001,
        })
      }

      send(404, { status: 'error', error: 'unknown endpoint' })
    })
    server.listen(MOCK_PORT, '127.0.0.1', () => resolvePromise())
    server.unref()
  })
}

// ---------------------------------------------------------------------------
// Webhook senders (GET IPN signed over the URL, POST payout signed over body)
// ---------------------------------------------------------------------------

async function sendIpn(
  fields: Record<string, string>,
  opts: { auth?: 'rsa' | 'hmac' | 'both' | 'forged' | 'none' } = {},
): Promise<{ status: number; text: string }> {
  const sp = new URLSearchParams(fields)
  const query = sp.toString()
  const auth = opts.auth ?? 'both'

  const headers: Record<string, string> = {}
  if (auth === 'rsa' || auth === 'both') {
    headers['x-ca-signature'] = signRsa(`${ORIGIN}/api/webhooks/blockbee?${query}`)
  }
  if (auth === 'hmac' || auth === 'both') {
    sp.set('token', hmacToken(query))
  }
  if (auth === 'forged') {
    sp.set('token', 'f'.repeat(64))
  }

  const res = await fetch(`${ORIGIN}/api/webhooks/blockbee?${sp.toString()}`, { headers })
  return { status: res.status, text: await res.text() }
}

async function sendPayoutWebhook(
  fields: Record<string, string>,
  opts: { auth?: 'rsa' | 'forged' } = {},
): Promise<{ status: number; text: string }> {
  const body = new URLSearchParams(fields).toString()
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if ((opts.auth ?? 'rsa') === 'rsa') {
    headers['x-ca-signature'] = signRsa(body)
  }
  const res = await fetch(`${ORIGIN}/api/webhooks/blockbee`, { method: 'POST', headers, body })
  return { status: res.status, text: await res.text() }
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await startMock()
  console.log(`— 0. mock processor on ${MOCK} (RSA-2048) —`)
  check(true, 'mock BlockBee listening')

  console.log('— 1. seed: referrer + referred advertiser + sessions —')
  const suffix = Date.now()
  const referrer = await db.user.create({
    data: {
      email: `bb-referrer-${suffix}@test.local`,
      name: 'Referrer',
      referralCode: `REF${String(suffix).slice(-5)}`,
    },
  })
  const advertiser = await db.user.create({
    data: {
      email: `bb-advertiser-${suffix}@test.local`,
      name: 'Referred Advertiser',
      referredById: referrer.id,
    },
  })
  await db.session.create({
    data: { tokenHash: sha256(SESSION_TOKEN), userId: advertiser.id, expiresAt: new Date(Date.now() + 3600_000) },
  })
  await db.session.create({
    data: { tokenHash: sha256(REFERRER_TOKEN), userId: referrer.id, expiresAt: new Date(Date.now() + 3600_000) },
  })
  check(Boolean(referrer.id && advertiser.id), 'users + sessions seeded')

  console.log('— 2. wallet-first ads flow: deposit intention → campaign funded from the wallet —')
  // Campaign SUBMISSION (Phase 2: create-as-draft is free, submit:true is
  // the money gate) BEFORE the wallet holds money → rejected. See
  // /api/ads/campaigns — a draft never locks wallet funds.
  const premature = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Premature campaign',
      format: 'text',
      billingModel: 'cpc',
      bidCents: 50,
      budgetCents: 1000,
      dailyBudgetCents: 0,
      targetUrl: 'https://acme.example',
      headline: 'No wallet funds yet.',
      body: 'Waiting for a deposit.',
      submit: true,
    },
  })
  check(premature.status === 400 && premature.data?.code === 'insufficient_wallet', 'campaign submission with empty wallet → 400 insufficient_wallet')

  const list = await call('/api/ads/campaigns')
  check(list.data?.topUp?.mode === 'blockbee', 'campaigns GET advertises blockbee mode')
  check(
    Array.isArray(list.data?.topUp?.coins) &&
      list.data.topUp.coins.includes('polygon_usdt') &&
      !list.data.topUp.coins.some((c: string) => c.startsWith('trc20') || c === 'trx'),
    'coin allowlist served, TRON absent',
  )

  const tronTopUp = await call('/api/ads/topups', {
    method: 'POST',
    body: { amountCents: 500, coin: 'trc20_usdt' },
  })
  check(tronTopUp.status === 400, 'TRON top-up rejected (policy ban)')

  const unknownCoin = await call('/api/ads/topups', {
    method: 'POST',
    body: { amountCents: 500, coin: 'bitcoin' },
  })
  check(unknownCoin.status === 400, 'coin outside allowlist rejected')

  const topUp = await call('/api/ads/topups', {
    method: 'POST',
    body: { amountCents: 500, coin: 'polygon_usdt' },
  })
  check(topUp.status === 201, `wallet deposit intention created (got ${topUp.status})`)
  const topUpId = topUp.data?.id as string
  check(/^MOCK[a-f0-9]{34}$/.test(topUp.data?.walletAddress ?? ''), 'hosted address from BlockBee returned')
  check(topUp.data?.provider === 'blockbee' && topUp.data?.coin === 'polygon_usdt', 'provider + coin echoed')

  const walletPending = await call('/api/ads/wallet')
  check(
    walletPending.data?.availableMicroUsd === 0 && walletPending.data?.pendingCents === 500,
    'wallet shows the pending deposit (available still 0 µUSD)',
  )

  const mockCreate = createdIntentions[createdIntentions.length - 1]
  check(
    Boolean(mockCreate && mockCreate.callback.includes(`order_id=${topUpId}`) && mockCreate.callback.includes('nonce=')),
    'callback URL embeds order_id + per-intention nonce',
  )
  check(mockCreate?.convert === '1' && mockCreate?.apikey === API_KEY, 'create call sent apikey + convert=1')

  const dbTopUp = await db.cryptoTopUp.findUnique({ where: { id: topUpId } })
  check(dbTopUp?.provider === 'blockbee' && dbTopUp?.callbackNonce !== null, 'intention persisted with nonce')

  console.log('— 3. pending IPN (RSA-signed GET) —')
  const ipnBase = {
    order_id: topUpId,
    nonce: dbTopUp!.callbackNonce!,
    uuid: crypto.randomUUID(),
    address_in: topUp.data.walletAddress,
    address_out: 'MOCKPAYOUTADDR',
    txid_in: '0xtxin111',
    value_coin: '5',
    value_coin_convert: '{"USD":"5.00"}',
    value_forwarded_coin: '4.99',
    fee_coin: '0.01',
    coin: 'polygon_usdt',
    price: '1',
  }
  const pending = await sendIpn({ ...ipnBase, pending: '1' }, { auth: 'rsa' })
  check(pending.status === 200 && pending.text === '*ok*', 'pending IPN acked *ok*')
  const afterPending = await db.cryptoTopUp.findUnique({ where: { id: topUpId } })
  check(afterPending?.status === 'pending' && afterPending?.uuid === ipnBase.uuid, 'still pending, uuid snapshotted')

  console.log('— 4. confirmed IPN (HMAC token) → wallet credit + 50% referral —')
  const confirmed = await sendIpn({ ...ipnBase, pending: '0', txid_in: '0xtxin222' }, { auth: 'hmac' })
  check(confirmed.status === 200, 'confirmed IPN accepted (HMAC path)')

  const advertiserWallet = await db.wallet.findFirst({ where: { userId: advertiser.id } })
  check(
    advertiserWallet?.availableMicroUsd === 5_000_000,
    `ad wallet credited 500¢ = 5,000,000 µUSD (got ${advertiserWallet?.availableMicroUsd})`,
  )
  const creditLedger = await db.ledgerEntry.findUnique({ where: { eventId: `topup:${topUpId}` } })
  check(
    creditLedger?.type === 'credit' && creditLedger?.amountMicroUsd === 5_000_000,
    'CREDIT ledger row written exactly once (eventId topup:<id>)',
  )
  const referrerRow = await db.user.findUnique({ where: { id: referrer.id } })
  check(referrerRow?.referralBalance === 250, `referrer earned 250¢ — 50% (got ${referrerRow?.referralBalance})`)

  const walletAfter = await call('/api/ads/wallet')
  check(walletAfter.data?.availableMicroUsd === 5_000_000, `wallet tab shows 5,000,000 µUSD (got ${walletAfter.data?.availableMicroUsd})`)
  check(walletAfter.data?.pendingCents === 0, 'pending deposit cleared')
  check(
    Array.isArray(walletAfter.data?.topUps) && walletAfter.data.topUps.some((t: any) => t.id === topUpId && t.status === 'confirmed'),
    'deposit history lists the confirmed intention',
  )
  check(
    walletAfter.data?.ledger?.some((l: any) => l.eventId === `topup:${topUpId}` && l.type === 'credit'),
    'wallet ledger table lists the credit movement',
  )

  console.log('— 5. campaign funded from the wallet —')
  const created = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'BlockBee test campaign',
      format: 'text',
      billingModel: 'cpc',
      bidCents: 10, // $0.10 per click — 20-event minimum = $2.00 ≤ the $5 wallet
      budgetCents: 500,
      dailyBudgetCents: 0,
      targetUrl: 'https://acme.example',
      headline: 'Paying with hosted addresses.',
      body: 'BlockBee → wallet → campaign budget.',
      submit: true,
    },
  })
  check(created.status === 201, `campaign created + submitted from wallet (got ${created.status})`)
  check(created.data?.status === 'pending', 'submitted campaign enters moderation (PENDING — the Phase 2 lifecycle)')
  const campaignId = created.data?.id as string
  // The full Telegram-moderation journey is covered by the ads e2e; here the
  // decision is applied directly so the payment rails can continue.
  await db.campaign.update({ where: { id: campaignId }, data: { status: 'active' } })
  await db.creative.updateMany({ where: { campaignId }, data: { moderationStatus: 'approved' } })
  check(true, 'campaign approved (direct DB) — payment flow continues')

  const walletSpent = await call('/api/ads/wallet')
  check(walletSpent.data?.availableMicroUsd === 0, 'wallet drained by the allocation')
  check(walletSpent.data?.reservedMicroUsd === 5_000_000, 'reserved bucket holds the committed flight budget')

  let campaignRow = (await call('/api/ads/campaigns')).data?.campaigns?.find((c: any) => c.id === campaignId)
  check(
    campaignRow?.budget?.remainingMicroUsd === 5_000_000,
    `campaign remaining budget 5,000,000 µUSD (got ${campaignRow?.budget?.remainingMicroUsd})`,
  )
  const reserveLedger = await db.ledgerEntry.findFirst({ where: { campaignId, type: 'reserve' } })
  check(reserveLedger?.amountMicroUsd === -5_000_000, 'RESERVE ledger row written for the allocation')

  console.log('— 5b. duplicate confirmed IPN → idempotent —')
  const dup = await sendIpn({ ...ipnBase, pending: '0', txid_in: '0xtxin222' }, { auth: 'both' })
  check(dup.status === 200, 'duplicate IPN acked')
  const advertiserDup = await db.wallet.findFirst({ where: { userId: advertiser.id } })
  check(
    advertiserDup?.availableMicroUsd === 0,
    `no double wallet credit (still 0 µUSD available, got ${advertiserDup?.availableMicroUsd})`,
  )
  const referrerRow2 = await db.user.findUnique({ where: { id: referrer.id } })
  check(referrerRow2?.referralBalance === 250, `no double commission (still 250¢, got ${referrerRow2?.referralBalance})`)
  campaignRow = (await call('/api/ads/campaigns')).data?.campaigns?.find((c: any) => c.id === campaignId)
  check(
    campaignRow?.budget?.remainingMicroUsd === 5_000_000,
    `campaign budget untouched by the duplicate (got ${campaignRow?.budget?.remainingMicroUsd})`,
  )

  console.log('— 6. signature rails —')
  const forged = await sendIpn({ ...ipnBase, pending: '0' }, { auth: 'forged' })
  check(forged.status === 401, 'forged HMAC token → 401')
  const unsigned = await sendIpn({ ...ipnBase, pending: '0' }, { auth: 'none' })
  check(unsigned.status === 401, 'no signature at all → 401')
  const wrongNonce = await sendIpn({ ...ipnBase, pending: '0', nonce: 'deadbeef' }, { auth: 'both' })
  check(wrongNonce.status === 200, 'wrong nonce acked (no retry storm)')
  const unknownOrder = await sendIpn({ ...ipnBase, order_id: 'does-not-exist' }, { auth: 'both' })
  check(unknownOrder.status === 200, 'unknown order_id acked')
  const rejectedLogs = await db.paymentLog.count({
    where: { source: 'blockbee_ipn', event: 'rejected' },
  })
  check(rejectedLogs >= 3, `rejections logged to PaymentLog (${rejectedLogs} rows)`)
  const confirmedLog = await db.paymentLog.findFirst({
    where: { source: 'blockbee_ipn', event: 'confirmed', referenceId: topUpId },
  })
  check(Boolean(confirmedLog && confirmedLog.amountCents === 500), 'confirmed event logged with amount')
  const commissionLog = await db.paymentLog.findFirst({
    where: { source: 'referral_commission', userId: referrer.id },
  })
  check(Boolean(commissionLog && commissionLog.amountCents === 250), 'commission event logged')

  console.log('— 7. referral registration (?ref=CODE) —')
  const reg = await call('/api/auth/register', {
    method: 'POST',
    auth: null,
    body: {
      email: `bb-friend-${suffix}@test.local`,
      password: 'correct-horse-battery-99',
      name: 'Referred Friend',
      acceptTerms: true,
      referralCode: referrer.referralCode,
    },
  })
  check(reg.status === 201, `friend registered with ref code (got ${reg.status})`)
  const friend = await db.user.findUnique({ where: { email: `bb-friend-${suffix}@test.local` } })
  check(friend?.referredById === referrer.id, 'friend bound to referrer')
  check(Boolean(friend?.referralCode), 'friend born with own referral code')

  console.log('— 8. referral cabinet —')
  const cabinet = await call('/api/account/referral', { auth: REFERRER_TOKEN })
  check(cabinet.data?.referralBalanceCents === 250, `cabinet shows 250¢ (got ${cabinet.data?.referralBalanceCents})`)
  check(cabinet.data?.earnedTotalCents === 250, 'earned total 250¢')
  check(cabinet.data?.referredCount === 2, `referred count 2 (got ${cabinet.data?.referredCount})`)
  check(
    typeof cabinet.data?.referralLink === 'string' && cabinet.data.referralLink.includes(`ref=${referrer.referralCode}`),
    'shareable referral link served',
  )
  check(cabinet.data?.withdraw?.enabled === true, 'withdrawals enabled in cabinet')

  console.log('— 9. withdrawal via the payout chain —')
  const tooSmall = await call('/api/account/referral/withdraw', {
    method: 'POST',
    auth: REFERRER_TOKEN,
    body: { coin: 'polygon_usdt', address: '0x1234567890abcdef1234567890abcdef12345678' },
  })
  check(tooSmall.status === 400, 'below-minimum withdrawal rejected (250¢ < $20)')

  // Fund the referrer to a realistic balance for the payout tests.
  await db.user.update({ where: { id: referrer.id }, data: { referralBalance: 6000 } })

  const badCoin = await call('/api/account/referral/withdraw', {
    method: 'POST',
    auth: REFERRER_TOKEN,
    body: { coin: 'btc', address: '0x1234567890abcdef1234567890abcdef12345678', amountCents: 2500 },
  })
  check(badCoin.status === 400, 'withdrawal coin outside allowlist rejected')

  const withdraw = await call('/api/account/referral/withdraw', {
    method: 'POST',
    auth: REFERRER_TOKEN,
    body: { coin: 'polygon_usdt', address: '0x1234567890abcdef1234567890abcdef12345678', amountCents: 2500 },
  })
  check(withdraw.status === 200, `withdrawal submitted (got ${withdraw.status}: ${JSON.stringify(withdraw.data)})`)
  const payoutId = withdraw.data?.payoutId as string
  check(Boolean(payoutId), 'payout id returned')
  check(withdraw.data?.status === 'processing', `withdrawal processing (got ${withdraw.data?.status})`)

  const notYetDeducted = await db.user.findUnique({ where: { id: referrer.id } })
  check(notYetDeducted?.referralBalance === 6000, 'balance NOT deducted before payout confirmation')

  const secondWithdraw = await call('/api/account/referral/withdraw', {
    method: 'POST',
    auth: REFERRER_TOKEN,
    body: { coin: 'polygon_usdt', address: '0x1234567890abcdef1234567890abcdef12345678', amountCents: 2000 },
  })
  check(secondWithdraw.status === 409, 'second concurrent withdrawal blocked (single-active guard)')

  check(payoutRequests.length === 1 && payoutRequests[0].address === '0x1234567890abcdef1234567890abcdef12345678',
    'payout request created at processor with user address')

  console.log('— 10. payout webhook: done → deduct —')
  const payoutFields = {
    id: payoutId,
    status: 'done',
    display_status: 'Done',
    total_requested: '25',
    total_requested_fiat: '25.00',
    total_with_fee: '25.01',
    total_with_fee_fiat: '25.01',
    error: '',
    blockchain_fee: '0.001',
    fee: '0.01',
    coin: 'polygon_usdt',
    timestamp: '01/01/2026 12:00:00',
  }
  const payoutDone = await sendPayoutWebhook(payoutFields)
  check(payoutDone.status === 200, 'payout webhook accepted')
  const afterDone = await db.user.findUnique({ where: { id: referrer.id } })
  check(afterDone?.referralBalance === 3500, `balance deducted on done (3500¢ left, got ${afterDone?.referralBalance})`)
  const withdrawalRow = await db.referralWithdrawal.findUnique({ where: { payoutId } })
  check(withdrawalRow?.status === 'done', 'withdrawal row marked done')

  const payoutDup = await sendPayoutWebhook(payoutFields)
  check(payoutDup.status === 200, 'duplicate payout webhook acked')
  const afterDup = await db.user.findUnique({ where: { id: referrer.id } })
  check(afterDup?.referralBalance === 3500, 'no double deduction')

  const payoutForged = await sendPayoutWebhook({ ...payoutFields, status: 'done' }, { auth: 'forged' })
  check(payoutForged.status === 401, 'forged payout webhook → 401')

  console.log('— 11. payout webhook: error → balance untouched —')
  const withdraw2 = await call('/api/account/referral/withdraw', {
    method: 'POST',
    auth: REFERRER_TOKEN,
    body: { coin: 'sol', address: 'DtN9aWtVvcRfUvSNgHdDcjiLXZPcMNHwLdMx7vBcW3qP' },
  })
  check(withdraw2.status === 200, `second withdrawal (full balance, sol) submitted (got ${withdraw2.status})`)
  const payout2 = withdraw2.data?.payoutId as string
  if (!payout2) {
    check(false, 'payout id for the sol withdrawal missing — cannot continue')
  } else {
    const payoutError = await sendPayoutWebhook({
      ...payoutFields,
      id: payout2,
      status: 'error',
      error: 'Not enough balance',
      coin: 'sol',
    })
    check(payoutError.status === 200, 'error payout webhook acked')
    const afterError = await db.user.findUnique({ where: { id: referrer.id } })
    check(afterError?.referralBalance === 3500, 'failed payout never deducts (3500¢ intact)')
    const failedRow = await db.referralWithdrawal.findUnique({ where: { payoutId: payout2 } })
    check(failedRow?.status === 'failed' && failedRow?.error === 'Not enough balance', 'withdrawal marked failed with reason')
  }

  console.log('— 12. payout test sentinel + unknown payout —')
  const sentinel = await sendPayoutWebhook({ ...payoutFields, id: '00000000-0000-0000-0000-000000000000' })
  check(sentinel.status === 200, 'dashboard test sentinel acked as no-op')
  const unknownPayout = await sendPayoutWebhook({ ...payoutFields, id: crypto.randomUUID() })
  check(unknownPayout.status === 200, 'unknown payout id acked (operator-initiated)')

  console.log('— 13. webhook rate limit —')
  let rateLimited = false
  for (let i = 0; i < 65; i++) {
    const r = await fetch(`${ORIGIN}/api/webhooks/blockbee?uuid=x&address_in=y`, {
      headers: { 'X-Forwarded-For': '203.0.113.77' },
    })
    if (r.status === 429) {
      rateLimited = true
      break
    }
  }
  check(rateLimited, 'rate limit kicks in under a flood (429)')

  console.log('— 14. cleanup —')
  const seededEmails = [
    `bb-referrer-${suffix}@test.local`,
    `bb-advertiser-${suffix}@test.local`,
    `bb-friend-${suffix}@test.local`,
  ]
  await db.user.deleteMany({ where: { email: { in: seededEmails } } })
  check(true, 'seeded users removed (cascades campaigns/top-ups/withdrawals)')

  console.log('')
  if (fail > 0) {
    console.log(`FAILED: ${fail} check(s) failed (${pass} passed)`)
    process.exit(1)
  }
  console.log(`ALL PASS — ${pass} checks`)
}

main()
  .catch((err) => {
    console.error('[blockbee-e2e] fatal:', err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
