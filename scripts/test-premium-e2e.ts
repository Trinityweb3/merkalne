/// <reference types="bun-types" />
/**
 * Merklane Premium — HTTP end-to-end test (checkout → IPN → activation →
 * paywalls).
 *
 * Runs a MOCK BlockBee API in-process (real RSA-2048 keypair, same endpoints
 * and payload shapes as the production processor) and drives the FULL
 * subscription journey against a live dev server, plus the two paywalls that
 * monetise it:
 *
 *   pricing config (exact CEO rates $5/$30/$15/$90, coin allowlist, no TRON)
 *   → checkout gates (401 unauthenticated, 403 CSRF-less, 400 bad coin/plan)
 *   → Premium monthly order (prem_m_<userId>_… prefix, hosted address,
 *     callback URL contract: order_id + nonce + convert=1)
 *   → RSA-signed pending IPN (snapshot only, still pending)
 *   → HMAC-signed confirmed IPN → plan=premium, premiumUntil ≈ +30 days
 *   → duplicate IPN → idempotent (no double grant)
 *   → renewal → stacks from the CURRENT premiumUntil (not from now)
 *   → Premium+ yearly order (premplus_y_ prefix) → +365 days
 *   → underpaid IPN (<90%) → NOT activated, logged; follow-up full payment
 *     → activates
 *   → forged signature 401 · wrong nonce / unknown order acked-not-credited
 *   → order polling endpoint (owner 200 / foreign 404 / anonymous 401)
 *   → Telegram notifier paywall: /alerts on blocked for free + EXPIRED
 *     users (🔒 reply, IngestionLog), allowed for active subscribers,
 *     /alerts off always free, /whoami shows Plan: Free/Premium/Premium+
 *   → dispatch gate (activePremiumUsers): only active paid users with
 *     enabled Telegram links become alert recipients — free and expired
 *     NEVER do
 *   → editorial publishing quotas: free/premium 403 in editorial sections,
 *     Premium+ publishes (5/month), 6th rejected, drafts exempt, Blog free
 *
 * Run via: bash scripts/run-premium-e2e.sh
 * (spawns the dev server on :3104 with BLOCKBEE_API_BASE=http://127.0.0.1:3198)
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { activePremiumUsers } from '@/lib/bots/dispatch'

const ORIGIN = (process.env.BASE_URL ?? 'http://localhost:3104').replace(/\/+$/, '')
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 3198)
const API_KEY = 'test-premium-blockbee-key'
const IPN_SECRET = 'test-premium-ipn-secret-0123456789abcdef'
const TG_SECRET = 'test-premium-tg-secret-0123456789abcdef'

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
const BUYER_TOKEN = crypto.randomBytes(32).toString('base64url')
const YEARLY_TOKEN = crypto.randomBytes(32).toString('base64url')
const UNDER_TOKEN = crypto.randomBytes(32).toString('base64url')
const AUTHOR_TOKEN = crypto.randomBytes(32).toString('base64url')
const PLUS_AUTHOR_TOKEN = crypto.randomBytes(32).toString('base64url')
const FREE_AUTHOR_TOKEN = crypto.randomBytes(32).toString('base64url')
const FOREIGN_TOKEN = crypto.randomBytes(32).toString('base64url')

function sha256(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex')
}

/** Authenticated JSON call. ip varies X-Forwarded-For to dodge IP rate limits. */
async function call(
  path: string,
  opts: {
    method?: string
    body?: unknown
    auth?: string | null
    csrf?: boolean
    ip?: string
  } = {},
): Promise<{ status: number; data: any }> {
  const auth = opts.auth !== undefined ? opts.auth : BUYER_TOKEN
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    'X-Forwarded-For': opts.ip ?? '127.0.0.99',
  }
  if ((opts.method ?? 'GET') !== 'GET' && opts.csrf !== false) headers['X-CSRF-Token'] = CSRF
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
// Mock BlockBee processor (payment-intention endpoints only)
// ---------------------------------------------------------------------------

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()

const createdIntentions: { coin: string; callback: string; apikey: string; convert: string }[] = []

function signRsa(data: string): string {
  return crypto.createSign('RSA-SHA256').update(data, 'utf8').sign(privateKey, 'base64')
}

function hmacToken(canonical: string): string {
  return crypto.createHmac('sha256', IPN_SECRET).update(canonical, 'utf8').digest('hex')
}

function startMock(): Promise<void> {
  return new Promise((resolvePromise) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${MOCK_PORT}`)
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const parts = url.pathname.split('/').filter(Boolean)

      if (req.method === 'GET' && url.pathname === '/pubkey/') {
        return send(200, { status: 'success', pubkey: PUBLIC_PEM })
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
// Webhook senders (GET IPN signed over the full URL)
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

// ---------------------------------------------------------------------------
// Telegram notifier webhook helpers (console-fallback mode: no bot token)
// ---------------------------------------------------------------------------

let tgUpdateId = 7000
async function tg(
  text: string,
  chatId: string,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${ORIGIN}/api/webhooks/telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': TG_SECRET,
    },
    body: JSON.stringify({
      update_id: tgUpdateId++,
      message: {
        message_id: tgUpdateId,
        from: { id: Number(chatId), first_name: 'E2E' },
        chat: { id: Number(chatId), type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }),
  })
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

/** Build the base IPN field set for one premium order. */
function ipnFor(
  order: { id: string; walletAddress: string; amountExpectedCents: number },
  usd: string,
  nonce: string,
): Record<string, string> {
  return {
    order_id: order.id,
    nonce,
    uuid: crypto.randomUUID(),
    address_in: order.walletAddress,
    address_out: 'MOCKPAYOUTADDR',
    txid_in: `0x${crypto.randomBytes(8).toString('hex')}`,
    value_coin: usd,
    value_coin_convert: `{"USD":"${usd}"}`,
    value_forwarded_coin: usd,
    fee_coin: '0.00',
    coin: 'polygon_usdt',
    price: '1',
  }
}

const DAY = 24 * 3600 * 1000

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await startMock()
  console.log(`— 0. mock processor on 127.0.0.1:${MOCK_PORT} (RSA-2048) —`)
  check(true, 'mock BlockBee listening')

  console.log('— 1. seed users + sessions + telegram links —')
  const suffix = Date.now()
  const mkUser = (name: string, extra: Record<string, unknown> = {}) =>
    db.user.create({ data: { email: `prem-${name}-${suffix}@test.local`, name, ...extra } })
  const mkSession = (userId: string, token: string) =>
    db.session.create({
      data: { tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + 3600_000) },
    })
  const mkLink = (userId: string, chatId: string, notificationsEnabled = false) =>
    db.telegramLink.create({
      data: {
        userId,
        chatId,
        linkTokenHash: sha256(crypto.randomBytes(16).toString('hex')),
        notificationsEnabled,
        linkedAt: new Date(),
      },
    })

  const buyer = await mkUser('Buyer') // walks the monthly journey + renewal
  const yearly = await mkUser('Yearly') // premium+ yearly
  const under = await mkUser('Underpaid') // premium+ monthly, underpays first
  const author = await mkUser('Author', {
    plan: 'premium',
    premiumUntil: new Date(Date.now() + 5 * DAY),
  }) // standard premium — NOT enough for editorial
  const plusAuthor = await mkUser('PlusAuthor', {
    plan: 'premium_plus',
    premiumUntil: new Date(Date.now() + 300 * DAY),
  })
  const freeAuthor = await mkUser('FreeAuthor')
  const foreign = await mkUser('Foreign')
  // Telegram paywall actors
  const tgFree = await mkUser('TgFree')
  const tgExpired = await mkUser('TgExpired', {
    plan: 'premium',
    premiumUntil: new Date(Date.now() - DAY),
  })
  const tgPlusExpired = await mkUser('TgPlusExpired', {
    plan: 'premium_plus',
    premiumUntil: new Date(Date.now() - 2 * DAY),
  })
  const tgActive = await mkUser('TgActive', {
    plan: 'premium',
    premiumUntil: new Date(Date.now() + 10 * DAY),
  })
  // Dispatch-gate actors (no sessions needed)
  const dispatchFree = await mkUser('DispatchFree')
  const dispatchExpired = await mkUser('DispatchExpired', {
    plan: 'premium_plus',
    premiumUntil: new Date(Date.now() - 1),
  })
  const dispatchNever = await mkUser('DispatchNever', { plan: 'premium', premiumUntil: null })
  const dispatchPlus = await mkUser('DispatchPlus', {
    plan: 'premium_plus',
    premiumUntil: new Date(Date.now() + 40 * DAY),
  })
  const dispatchMuted = await mkUser('DispatchMuted', {
    plan: 'premium',
    premiumUntil: new Date(Date.now() + 40 * DAY),
  })

  await Promise.all([
    mkSession(buyer.id, BUYER_TOKEN),
    mkSession(yearly.id, YEARLY_TOKEN),
    mkSession(under.id, UNDER_TOKEN),
    mkSession(author.id, AUTHOR_TOKEN),
    mkSession(plusAuthor.id, PLUS_AUTHOR_TOKEN),
    mkSession(freeAuthor.id, FREE_AUTHOR_TOKEN),
    mkSession(foreign.id, FOREIGN_TOKEN),
  ])
  await mkLink(tgFree.id, '910001')
  await mkLink(tgExpired.id, '910002')
  await mkLink(tgPlusExpired.id, '910003')
  await mkLink(tgActive.id, '910004')
  await mkLink(dispatchFree.id, '920001', true)
  await mkLink(dispatchExpired.id, '920002', true)
  await mkLink(dispatchNever.id, '920003', true)
  await mkLink(dispatchPlus.id, '920004', true)
  await mkLink(dispatchMuted.id, '920005', false) // premium but alerts paused
  check(true, 'users, sessions, telegram links seeded')

  console.log('— 2. pricing config (server-side catalog) —')
  const cfg = await call('/api/premium/checkout', { auth: null })
  check(cfg.status === 200, 'GET /api/premium/checkout public')
  check(cfg.data?.configured === true, 'BlockBee advertised as configured')
  check(
    cfg.data?.pricing?.premium?.monthlyCents === 500 &&
      cfg.data?.pricing?.premium?.yearlyCents === 3000,
    'Premium pricing exactly $5.00 / $30.00',
  )
  check(
    cfg.data?.pricing?.premium_plus?.monthlyCents === 1500 &&
      cfg.data?.pricing?.premium_plus?.yearlyCents === 9000,
    'Premium+ pricing exactly $15.00 / $90.00',
  )
  check(
    Array.isArray(cfg.data?.coins) &&
      cfg.data.coins.includes('polygon_usdt') &&
      !cfg.data.coins.some((c: string) => c === 'trx' || c.startsWith('trc20')),
    'coin allowlist served, TRON absent',
  )

  console.log('— 3. checkout gates —')
  const anon = await call('/api/premium/checkout', {
    method: 'POST',
    auth: null,
    body: { plan: 'premium', period: 'monthly', coin: 'polygon_usdt' },
  })
  check(anon.status === 401, `unauthenticated checkout → 401 (got ${anon.status})`)

  const noCsrf = await call('/api/premium/checkout', {
    method: 'POST',
    csrf: false,
    body: { plan: 'premium', period: 'monthly', coin: 'polygon_usdt' },
  })
  check(noCsrf.status === 403, `CSRF-less checkout → 403 (got ${noCsrf.status})`)

  const tron = await call('/api/premium/checkout', {
    method: 'POST',
    body: { plan: 'premium', period: 'monthly', coin: 'trc20_usdt' },
  })
  check(tron.status === 400, 'TRON checkout rejected (policy ban)')

  const badCoin = await call('/api/premium/checkout', {
    method: 'POST',
    body: { plan: 'premium', period: 'monthly', coin: 'bitcoin' },
  })
  check(badCoin.status === 400, 'coin outside allowlist rejected')

  const badPlan = await call('/api/premium/checkout', {
    method: 'POST',
    body: { plan: 'enterprise', period: 'monthly', coin: 'polygon_usdt' },
  })
  check(badPlan.status === 400, 'unknown plan rejected')

  console.log('— 4. Premium monthly checkout → pending IPN → confirmed IPN —')
  const monthly = await call('/api/premium/checkout', {
    method: 'POST',
    body: { plan: 'premium', period: 'monthly', coin: 'polygon_usdt' },
  })
  check(monthly.status === 201, `monthly checkout created (got ${monthly.status})`)
  const monthlyId = monthly.data?.id as string
  check(
    monthlyId.startsWith(`prem_m_${buyer.id}_`),
    `order id carries prem_m_<userId> prefix (${monthlyId})`,
  )
  check(monthly.data?.amountExpectedCents === 500, 'expected amount is exactly 500¢')
  check(/^MOCK[a-f0-9]{34}$/.test(monthly.data?.walletAddress ?? ''), 'hosted address from BlockBee')
  check(monthly.data?.status === 'pending' && monthly.data?.provider === 'blockbee', 'pending blockbee order')

  const mockCreate = createdIntentions[createdIntentions.length - 1]
  check(
    Boolean(mockCreate && mockCreate.callback.includes(`order_id=${monthlyId}`) && mockCreate.callback.includes('nonce=')),
    'callback URL embeds order_id + per-intention nonce',
  )
  check(mockCreate?.convert === '1' && mockCreate?.apikey === API_KEY, 'create call sent apikey + convert=1')

  const dbOrder = await db.premiumOrder.findUnique({ where: { id: monthlyId } })
  check(Boolean(dbOrder?.callbackNonce && dbOrder?.days === 30), 'order persisted with nonce + 30 days')

  const monthlyOrder = { id: monthlyId, walletAddress: monthly.data.walletAddress, amountExpectedCents: 500 }
  const pending = await sendIpn({ ...ipnFor(monthlyOrder, '5.00', dbOrder!.callbackNonce!), pending: '1' }, { auth: 'rsa' })
  check(pending.status === 200 && pending.text === '*ok*', 'pending IPN acked *ok*')
  const afterPending = await db.premiumOrder.findUnique({ where: { id: monthlyId } })
  check(afterPending?.status === 'pending' && afterPending?.uuid !== null, 'still pending after mempool sighting')

  const confirmed = await sendIpn({ ...ipnFor(monthlyOrder, '5.00', dbOrder!.callbackNonce!), pending: '0' }, { auth: 'hmac' })
  check(confirmed.status === 200, 'confirmed IPN accepted (HMAC path)')

  const buyerAfter = await db.user.findUnique({ where: { id: buyer.id } })
  check(buyerAfter?.plan === 'premium', `user plan flipped to premium (got ${buyerAfter?.plan})`)
  const daysGranted =
    buyerAfter?.premiumUntil ? (buyerAfter.premiumUntil.getTime() - Date.now()) / DAY : 0
  check(daysGranted > 29.9 && daysGranted <= 30.1, `premiumUntil ≈ +30 days (got ${daysGranted.toFixed(2)})`)

  const orderAfter = await db.premiumOrder.findUnique({ where: { id: monthlyId } })
  check(orderAfter?.status === 'confirmed' && orderAfter?.amountReceived === 500, 'order confirmed with 500¢ received')

  const payLog = await db.paymentLog.findFirst({
    where: { source: 'blockbee_ipn', event: 'confirmed', referenceId: monthlyId },
  })
  check(
    Boolean(payLog && payLog.amountCents === 500 && (payLog.detail as any)?.target === 'subscription' && (payLog.detail as any)?.plan === 'premium'),
    'PaymentLog confirmed row (target subscription, plan premium)',
  )

  console.log('— 5. duplicate confirmed IPN → idempotent —')
  const firstUntil = buyerAfter!.premiumUntil!.getTime()
  const dup = await sendIpn({ ...ipnFor(monthlyOrder, '5.00', dbOrder!.callbackNonce!), pending: '0' }, { auth: 'both' })
  check(dup.status === 200, 'duplicate IPN acked')
  const buyerDup = await db.user.findUnique({ where: { id: buyer.id } })
  check(buyerDup?.premiumUntil?.getTime() === firstUntil, 'no double grant (premiumUntil unchanged)')

  console.log('— 6. renewal stacks from current premiumUntil —')
  const renewal = await call('/api/premium/checkout', {
    method: 'POST',
    body: { plan: 'premium', period: 'monthly', coin: 'polygon_usdt' },
  })
  check(renewal.status === 201, 'renewal order created')
  const renewalOrder = {
    id: renewal.data?.id as string,
    walletAddress: renewal.data?.walletAddress as string,
    amountExpectedCents: 500,
  }
  const renewalRow = await db.premiumOrder.findUnique({ where: { id: renewalOrder.id } })
  const renewalIpn = await sendIpn(
    { ...ipnFor(renewalOrder, '5.00', renewalRow!.callbackNonce!), pending: '0' },
    { auth: 'hmac' },
  )
  check(renewalIpn.status === 200, 'renewal payment confirmed')
  const buyerRenewed = await db.user.findUnique({ where: { id: buyer.id } })
  const renewedDays =
    buyerRenewed?.premiumUntil ? (buyerRenewed.premiumUntil.getTime() - Date.now()) / DAY : 0
  check(renewedDays > 59.8 && renewedDays <= 60.2, `renewal stacked (≈60 days total, got ${renewedDays.toFixed(2)})`)

  console.log('— 7. Premium+ yearly —')
  const plusYearly = await call('/api/premium/checkout', {
    method: 'POST',
    auth: YEARLY_TOKEN,
    ip: '127.0.0.98',
    body: { plan: 'premium_plus', period: 'yearly', coin: 'polygon_usdc' },
  })
  check(plusYearly.status === 201, 'premium+ yearly checkout created')
  check(
    String(plusYearly.data?.id).startsWith(`premplus_y_${yearly.id}_`),
    `order id carries premplus_y_<userId> prefix`,
  )
  check(plusYearly.data?.amountExpectedCents === 9000, 'expected amount is exactly 9000¢ ($90)')
  const plusOrder = {
    id: plusYearly.data?.id as string,
    walletAddress: plusYearly.data?.walletAddress as string,
    amountExpectedCents: 9000,
  }
  const plusRow = await db.premiumOrder.findUnique({ where: { id: plusOrder.id } })
  const plusIpn = await sendIpn(
    { ...ipnFor(plusOrder, '90.00', plusRow!.callbackNonce!), pending: '0' },
    { auth: 'rsa' },
  )
  check(plusIpn.status === 200, 'premium+ yearly payment confirmed (RSA path)')
  const yearlyAfter = await db.user.findUnique({ where: { id: yearly.id } })
  check(yearlyAfter?.plan === 'premium_plus', 'plan flipped to premium_plus')
  const yearlyDays =
    yearlyAfter?.premiumUntil ? (yearlyAfter.premiumUntil.getTime() - Date.now()) / DAY : 0
  check(yearlyDays > 364.8 && yearlyDays <= 365.2, `premiumUntil ≈ +365 days (got ${yearlyDays.toFixed(2)})`)

  console.log('— 8. underpayment (<90%) does not activate; follow-up completes —')
  const underOrder1 = await call('/api/premium/checkout', {
    method: 'POST',
    auth: UNDER_TOKEN,
    ip: '127.0.0.97',
    body: { plan: 'premium_plus', period: 'monthly', coin: 'polygon_usdt' },
  })
  check(underOrder1.status === 201, 'premium+ monthly checkout created')
  const underOrder = {
    id: underOrder1.data?.id as string,
    walletAddress: underOrder1.data?.walletAddress as string,
    amountExpectedCents: 1500,
  }
  const underRow = await db.premiumOrder.findUnique({ where: { id: underOrder.id } })
  // $10.00 received on a $15.00 order → 66% < 90% tolerance → no activation
  const underIpn = await sendIpn(
    { ...ipnFor(underOrder, '10.00', underRow!.callbackNonce!), pending: '0' },
    { auth: 'hmac' },
  )
  check(underIpn.status === 200, 'underpaid IPN acked')
  const underUser1 = await db.user.findUnique({ where: { id: under.id } })
  check(underUser1?.plan === 'free', 'underpaid → plan NOT activated')
  const underRowAfter = await db.premiumOrder.findUnique({ where: { id: underOrder.id } })
  check(underRowAfter?.status === 'pending', 'underpaid order stays pending')
  const underLog = await db.paymentLog.findFirst({
    where: { event: 'underpaid', referenceId: underOrder.id },
  })
  check(Boolean(underLog), 'underpayment logged for the operator')
  // Follow-up payment to the SAME address completes the order
  const topUpIpn = await sendIpn(
    { ...ipnFor(underOrder, '15.00', underRow!.callbackNonce!), pending: '0' },
    { auth: 'hmac' },
  )
  check(topUpIpn.status === 200, 'follow-up full payment acked')
  const underUser2 = await db.user.findUnique({ where: { id: under.id } })
  check(underUser2?.plan === 'premium_plus', 'follow-up payment activates premium+')

  console.log('— 9. signature rails on premium orders —')
  const railsOrder = await call('/api/premium/checkout', {
    method: 'POST',
    body: { plan: 'premium', period: 'yearly', coin: 'polygon_usdt' },
  })
  const rails = {
    id: railsOrder.data?.id as string,
    walletAddress: railsOrder.data?.walletAddress as string,
    amountExpectedCents: 3000,
  }
  const railsRow = await db.premiumOrder.findUnique({ where: { id: rails.id } })
  const forged = await sendIpn({ ...ipnFor(rails, '30.00', railsRow!.callbackNonce!), pending: '0' }, { auth: 'forged' })
  check(forged.status === 401, 'forged HMAC token → 401')
  const unsigned = await sendIpn({ ...ipnFor(rails, '30.00', railsRow!.callbackNonce!), pending: '0' }, { auth: 'none' })
  check(unsigned.status === 401, 'no signature at all → 401')
  const buyerBeforeRails = await db.user.findUnique({ where: { id: buyer.id } })
  const wrongNonce = await sendIpn(
    { ...ipnFor(rails, '30.00', 'deadbeefdeadbeef'), pending: '0' },
    { auth: 'both' },
  )
  check(wrongNonce.status === 200, 'wrong nonce acked (no retry storm)')
  const unknownOrder = await sendIpn(
    { ...ipnFor(rails, '30.00', railsRow!.callbackNonce!), order_id: 'prem_m_nope_nope', pending: '0' },
    { auth: 'both' },
  )
  check(unknownOrder.status === 200, 'unknown premium order_id acked')
  const buyerAfterRails = await db.user.findUnique({ where: { id: buyer.id } })
  check(
    buyerAfterRails?.premiumUntil?.getTime() === buyerBeforeRails?.premiumUntil?.getTime(),
    'wrong-nonce / unknown-order IPNs granted nothing',
  )

  console.log('— 10. order polling endpoint —')
  const pollOwner = await call(`/api/premium/checkout/${monthlyId}`)
  check(pollOwner.status === 200 && pollOwner.data?.status === 'confirmed', 'owner polls own order')
  check(
    pollOwner.data?.user?.plan === 'premium' && typeof pollOwner.data?.user?.premiumUntil === 'string',
    'confirmed order returns the fresh user plan state',
  )
  const pollForeign = await call(`/api/premium/checkout/${monthlyId}`, { auth: FOREIGN_TOKEN })
  check(pollForeign.status === 404, `foreign session → 404 (got ${pollForeign.status})`)
  const pollAnon = await call(`/api/premium/checkout/${monthlyId}`, { auth: null })
  check(pollAnon.status === 401, 'anonymous poll → 401')
  const pollNonce = await db.premiumOrder.findUnique({ where: { id: monthlyId } })
  check(!JSON.stringify(pollOwner.data).includes(pollNonce?.callbackNonce ?? 'NONCE'), 'callbackNonce never exposed')

  console.log('— 11. Telegram notifier paywall —')
  const tgWrong = await fetch(`${ORIGIN}/api/webhooks/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': 'WRONG' },
    body: JSON.stringify({ update_id: 1, message: { chat: { id: 1 }, text: '/help' } }),
  })
  check(tgWrong.status === 403, 'wrong webhook secret → 403')

  const blockedFree = await tg('/alerts on', '910001')
  check(blockedFree.status === 200, '/alerts on from free user → 200 (bot reply carries the lock)')
  const linkFree = await db.telegramLink.findUnique({ where: { chatId: '910001' } })
  check(linkFree?.notificationsEnabled === false, 'free user alerts NOT enabled')
  const blockedLog = await db.ingestionLog.findFirst({
    where: { action: 'alerts-on-blocked-no-premium', actor: tgFree.id },
  })
  check(Boolean(blockedLog), 'blocked attempt logged to IngestionLog')

  const blockedExpired = await tg('/alerts on', '910002')
  check(blockedExpired.status === 200, 'expired premium user still blocked')
  const linkExpired = await db.telegramLink.findUnique({ where: { chatId: '910002' } })
  check(linkExpired?.notificationsEnabled === false, 'expired premium alerts NOT enabled')

  const blockedPlusExpired = await tg('/alerts on', '910003')
  check(blockedPlusExpired.status === 200, 'expired premium+ user still blocked')

  const allowed = await tg('/alerts on', '910004')
  check(allowed.status === 200, 'active premium user may enable alerts')
  const linkActive = await db.telegramLink.findUnique({ where: { chatId: '910004' } })
  check(linkActive?.notificationsEnabled === true, 'active premium alerts enabled')

  const paused = await tg('/alerts off', '910004')
  check(paused.status === 200, '/alerts off always allowed (free silence)')
  const linkPaused = await db.telegramLink.findUnique({ where: { chatId: '910004' } })
  check(linkPaused?.notificationsEnabled === false, 'alerts paused')

  const whoamiActive = await tg('/whoami', '910004')
  check(whoamiActive.status === 200, '/whoami responds')
  await tg('/alerts on', '910004') // re-enable for the dispatch check

  console.log('— 12. dispatch gate — the worker NEVER alerts non-subscribers —')
  const recipients = await activePremiumUsers()
  const ids = new Set(recipients.map((r) => r.id))
  check(ids.has(dispatchNever.id), 'never-expires grant is a recipient')
  check(ids.has(dispatchPlus.id), 'active premium+ is a recipient')
  check(!ids.has(dispatchFree.id), 'free user is NOT a recipient')
  check(!ids.has(dispatchExpired.id), 'expired premium+ is NOT a recipient')
  const muted = recipients.find((r) => r.id === dispatchMuted.id)
  check(Boolean(muted && muted.telegramChatId === null), 'paused telegram link → email-only recipient')
  const plus = recipients.find((r) => r.id === dispatchPlus.id)
  check(Boolean(plus && plus.telegramChatId === '920004'), 'enabled telegram link → chat recipient')
  check(!ids.has(tgFree.id) && !ids.has(tgExpired.id) && !ids.has(tgPlusExpired.id), 'telegram paywall actors excluded from dispatch')

  console.log('— 13. editorial publishing quotas (Premium+ only) —')
  const blogPost = await call('/api/posts', {
    method: 'POST',
    auth: FREE_AUTHOR_TOKEN,
    ip: '127.0.0.96',
    body: { section: 'blog', title: 'Blog stays free forever', body: 'Community content.', status: 'published' },
  })
  check(blogPost.status === 201, `Blog publishing free for everyone (got ${blogPost.status})`)

  const freeEditorial = await call('/api/posts', {
    method: 'POST',
    auth: FREE_AUTHOR_TOKEN,
    ip: '127.0.0.95',
    body: { section: 'intern-junior', title: 'Free user editorial attempt', body: 'Should be rejected.', status: 'published' },
  })
  check(freeEditorial.status === 403, 'free user cannot publish editorial')

  const premEditorial = await call('/api/posts', {
    method: 'POST',
    auth: AUTHOR_TOKEN,
    ip: '127.0.0.94',
    body: { section: 'intern-junior', title: 'Standard premium editorial attempt', body: 'Should be rejected.', status: 'published' },
  })
  check(premEditorial.status === 403, 'standard Premium is NOT enough for editorial')

  let published = 0
  for (let i = 1; i <= 5; i++) {
    const r = await call('/api/posts', {
      method: 'POST',
      auth: PLUS_AUTHOR_TOKEN,
      ip: `10.1.0.${i}`,
      body: {
        section: 'intern-junior',
        title: `Premium+ editorial post number ${i}`,
        body: `Editorial body ${i}.`,
        status: 'published',
      },
    })
    if (r.status === 201) published++
  }
  check(published === 5, `Premium+ publishes 5 editorial posts (got ${published})`)

  const sixth = await call('/api/posts', {
    method: 'POST',
    auth: PLUS_AUTHOR_TOKEN,
    ip: '10.1.0.9',
    body: {
      section: 'intern-junior',
      title: 'Premium+ editorial post number six',
      body: 'Should hit the quota.',
      status: 'published',
    },
  })
  check(
    sixth.status === 403 && sixth.data?.code === 'editorial_quota_reached',
    `6th published editorial post → quota 403 (got ${sixth.status})`,
  )

  const draft = await call('/api/posts', {
    method: 'POST',
    auth: PLUS_AUTHOR_TOKEN,
    ip: '10.1.0.10',
    body: {
      section: 'intern-junior',
      title: 'Premium+ editorial draft exempt from quota',
      body: 'Drafts stay free.',
      status: 'draft',
    },
  })
  check(draft.status === 201, 'drafts are exempt from the monthly quota')

  console.log('— 14. header chrome reflects the plan (session provider) —')
  const me = await call('/api/auth/session', { auth: BUYER_TOKEN })
  check(
    me.status === 200 && me.data?.user?.plan === 'premium' && typeof me.data?.user?.premiumUntil === 'string',
    me.status === 200
      ? 'session endpoint exposes plan + premiumUntil (drives the Premium Active badge)'
      : `session endpoint reachable (got ${me.status})`,
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
  .catch((err) => {
    console.error('E2E crashed:', err)
    process.exit(1)
  })
  .finally(() => {
    void db.$disconnect()
  })
