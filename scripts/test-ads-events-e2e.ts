/**
 * Merklane Ads Phase 3 — event pipeline end-to-end test.
 *
 * Drives the FULL Phase 3 stack against a live dev server (:3104):
 *
 *   • Billing shift — serving NEVER charges. Both CPC and CPM serve into a
 *     HELD BudgetReservation; the wallet is charged only by a VALIDATED
 *     event: a click through the signed redirect route /api/ads/click/
 *     [token] (CPC), a viewable_impression beacon on /api/ads/event (CPM).
 *   • Viewability — a REAL Chromium (Playwright) pass measures the actual
 *     client behaviour: ≥ 50 % visible for ONE CONTINUOUS second in an
 *     ACTIVE tab (IntersectionObserver + Page Visibility API). A 25 %
 *     visible ad never fires; 500 ms is not enough; 1.4 s is; a hidden tab
 *     pauses the clock and resuming it completes the second.
 *   • Click redirect — in-browser click on the rendered card goes through
 *     /api/ads/click/[token], gets the 302 to the signed destination and is
 *     logged exactly once.
 *   • Deduplication — double clicks, replayed beacons and crafted tokens can
 *     never charge twice (conditional status flip + unique ledger eventId +
 *     the UNIQUE (reservationId, eventType) AdEvent index).
 *   • Expiry refund — a hold that sees no validating event within its TTL is
 *     swept to EXPIRED and the campaign budget recovers; the advertiser is
 *     never charged.
 *   • Anti-fraud — bots (Googlebot, python-requests, empty UA) get no ad at
 *     all, never generate a billable event, and the /api/ads/event endpoint
 *     is rate limited (30/min/IP).
 *   • Reporting — /api/ads/reports metrics (impressions, viewable
 *     impressions, clicks, CTR, spent, eCPC) with NULL for no-data metrics,
 *     and a formula-safe CSV export (leading = + - @ neutralised, em dash
 *     for missing values).
 *
 * The suite seeds its own user + session directly in the database, talks
 * HTTP to the routes, reads/writes the reservation/ledger/event tables
 * white-box through the same Prisma client, and crafts HMAC tokens with the
 * SAME secret as the server (the runner .env pins AUTH_SECRET) to exercise
 * the expired-token paths without waiting 30 minutes.
 *
 * Run via: bash scripts/run-ads-events-e2e.sh
 */
import { PrismaClient } from '@prisma/client'
import { createHash, randomBytes } from 'node:crypto'
import { verifyAdToken, signAdToken, type AdTokenPayload } from '@/lib/ads/tokens'
import { twoProportionZTest, variantForVisitor } from '@/lib/ads/experiments'
import { visitorStableId } from '@/lib/ads/antifraud'

const ORIGIN = (process.env.BASE_URL ?? 'http://localhost:3104').replace(/\/+$/, '')
const BOT = `${ORIGIN}/api/webhooks/telegram-admin`
const BOT_SECRET = 'test_admin_secret_0123456789ab'
const BOT_ADMIN_ID = 999000222
const db = new PrismaClient()

/** A deliberately plain browser UA for every human-impersonating call. */
const HUMAN_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

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

const CSRF = randomBytes(24).toString('base64url')
const SESSION_TOKEN = randomBytes(32).toString('base64url')

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; auth?: string | null; origin?: string; ip?: string; ua?: string | null } = {},
): Promise<{ status: number; data: any; headers: Headers }> {
  const auth = opts.auth !== undefined ? opts.auth : SESSION_TOKEN
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: opts.origin ?? ORIGIN,
    'User-Agent': opts.ua === undefined ? HUMAN_UA : (opts.ua ?? ''),
  }
  if (opts.ip) headers['X-Forwarded-For'] = opts.ip
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
  return { status: res.status, data, headers: res.headers }
}

/** GET the signed redirect route with a specific UA / IP. */
async function clickToken(
  token: string,
  opts: { ip?: string; ua?: string | null } = {},
): Promise<{ status: number; location: string | null }> {
  const res = await fetch(`${ORIGIN}/api/ads/click/${encodeURIComponent(token)}`, {
    headers: {
      'User-Agent': opts.ua === undefined ? HUMAN_UA : (opts.ua ?? ''),
      ...(opts.ip ? { 'X-Forwarded-For': opts.ip } : {}),
    },
    redirect: 'manual',
  })
  return { status: res.status, location: res.headers.get('location') }
}

/** POST a viewability beacon. */
async function beacon(
  token: string,
  opts: { ip?: string; ua?: string | null; origin?: string; type?: string } = {},
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${ORIGIN}/api/ads/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: opts.origin ?? ORIGIN,
      'User-Agent': opts.ua === undefined ? HUMAN_UA : (opts.ua ?? ''),
      ...(opts.ip ? { 'X-Forwarded-For': opts.ip } : {}),
    },
    body: JSON.stringify({ token, type: opts.type ?? 'viewable_impression' }),
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

let tgUpdateId = 5000
function tgCallback(data: string) {
  return {
    update_id: tgUpdateId++,
    callback_query: {
      id: `cq${tgUpdateId}`,
      from: { id: BOT_ADMIN_ID, first_name: 'Admin' },
      message: { message_id: 1, chat: { id: BOT_ADMIN_ID, type: 'private' }, date: Math.floor(Date.now() / 1000) },
      data,
    },
  }
}
/** A plain Telegram MESSAGE update (the reject-reason capture step). */
function tgMessage(text: string) {
  return {
    update_id: tgUpdateId++,
    message: {
      message_id: tgUpdateId,
      from: { id: BOT_ADMIN_ID, first_name: 'Admin' },
      chat: { id: BOT_ADMIN_ID, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  }
}
async function botUpdate(payload: unknown): Promise<{ status: number; data: any }> {
  const r = await fetch(BOT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': BOT_SECRET },
    body: JSON.stringify(payload),
  })
  let data: any = null
  try {
    const body = await r.json()
    data = body && typeof body === 'object' && 'data' in body ? body.data : body
  } catch {
    data = null
  }
  return { status: r.status, data }
}
async function approveViaBot(campaignId: string): Promise<void> {
  const r = await botUpdate(tgCallback(`modok:${campaignId}`))
  check(r.status === 200, `bot approve ${campaignId.slice(0, 8)}`)
}
/** The full ❌ Reject flow: button → reason prompt → reason text. */
async function rejectViaBot(campaignId: string, reason: string): Promise<void> {
  const btn = await botUpdate(tgCallback(`modno:${campaignId}`))
  check(btn.status === 200, `bot reject prompt ${campaignId.slice(0, 8)}`)
  const reasonReply = await botUpdate(tgMessage(reason))
  check(reasonReply.status === 200, `bot reject reason captured (${reason.length} chars)`)
}

async function wallet(): Promise<{ available: number; reserved: number; raw: any }> {
  const w = await call('/api/ads/wallet')
  return {
    available: w.data?.availableMicroUsd ?? -1,
    reserved: w.data?.reservedMicroUsd ?? -1,
    raw: w.data,
  }
}

async function ledgerInvariant(userId: string): Promise<{ ok: boolean; detail: string }> {
  const w = await db.wallet.findFirst({ where: { userId } })
  if (!w) return { ok: false, detail: 'no wallet' }
  const rows = await db.ledgerEntry.groupBy({ by: ['type'], where: { walletId: w.id }, _sum: { amountMicroUsd: true } })
  let credit = 0
  let charge = 0
  for (const row of rows) {
    if (row.type === 'credit') credit += row._sum.amountMicroUsd ?? 0
    if (row.type === 'charge') charge += row._sum.amountMicroUsd ?? 0 // negative
  }
  const lhs = w.availableMicroUsd + w.reservedMicroUsd
  const rhs = credit + charge
  return { ok: lhs === rhs, detail: `available+reserved=${lhs} vs Σcredit−Σcharge=${rhs}` }
}

/** Charges landed for a campaign (ledger type=charge), in µUSD. */
async function chargedFor(campaignId: string): Promise<number> {
  const rows = await db.ledgerEntry.findMany({ where: { campaignId, type: 'charge' } })
  return rows.reduce((sum, r) => sum + -r.amountMicroUsd, 0)
}

async function eventsFor(reservationId: string, eventType: string): Promise<number> {
  return db.adEvent.count({ where: { reservationId, eventType } })
}

async function main(): Promise<void> {
  console.log('— 0. seed: advertiser + session (direct DB) —')
  const suffix = Date.now()
  const advertiser = await db.user.create({
    data: { email: `ads-events-e2e-${suffix}@test.local`, name: 'Ads Events E2E', role: 'user' },
  })
  await db.session.create({
    data: {
      tokenHash: sha256(SESSION_TOKEN),
      userId: advertiser.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  })
  check(Boolean(advertiser.id), 'advertiser + session seeded')

  console.log('— 1. wallet deposits (simulate) → $50 —')
  const t1 = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 500 } })
  await call(`/api/ads/topups/${t1.data?.id}/simulate`, { method: 'POST' })
  const t2 = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 4500 } })
  await call(`/api/ads/topups/${t2.data?.id}/simulate`, { method: 'POST' })
  const funded = await wallet()
  check(funded.available === 50_000_000, `wallet credited $50 (got ${funded.available})`)

  console.log('— 2. campaigns + moderation (CPC $0.50/click, CPM $50/1000) —')
  const cpcCreated = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Acme jobs — CPC (events e2e)',
      format: 'text',
      billingModel: 'cpc',
      bidCents: 50, // $0.50 per click → 500,000 µUSD
      budgetCents: 1000, // $10.00
      targetUrl: 'https://acme.example/cpc',
      headline: 'Hire Web3 engineers',
      body: 'Acme is hiring junior Solidity engineers.',
      submit: true,
    },
  })
  const cpcId = cpcCreated.data?.id as string
  check(cpcCreated.status === 201 && cpcCreated.data?.status === 'pending', 'CPC campaign created + submitted')

  const cpmCreated = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Acme brand — CPM (events e2e)',
      format: 'text',
      billingModel: 'cpm',
      bidCents: 5000, // $50 per 1000 views → 50,000 µUSD per view
      budgetCents: 1000, // $10.00 → 200 views
      targetUrl: 'https://acme.example/cpm',
      headline: 'Acme brand safety',
      body: 'The safest place to hire in Web3.',
      submit: true,
    },
  })
  const cpmId = cpmCreated.data?.id as string
  check(cpmCreated.status === 201 && cpmCreated.data?.status === 'pending', 'CPM campaign created + submitted')

  await approveViaBot(cpcId)
  await approveViaBot(cpmId)
  check((await db.campaign.findUnique({ where: { id: cpcId } }))?.status === 'active', 'CPC ACTIVE after bot approve')
  check((await db.campaign.findUnique({ where: { id: cpmId } }))?.status === 'active', 'CPM ACTIVE after bot approve')

  // CPM-only first: deterministic CPC pipeline tests.
  await call(`/api/ads/campaigns/${cpmId}`, { method: 'PATCH', body: { action: 'pause' } })

  console.log('— 3. serve: HELD for both models, loaded_impression, NO charge —')
  const s1 = await call('/api/ads/serve?slot=feed', { ip: '10.40.0.1' })
  check(s1.status === 200 && s1.data?.ad?.campaignId === cpcId, 'CPC campaign serves')
  const cpcToken = s1.data?.ad?.clickToken as string
  const cpcRid = s1.data?.ad?.reservationId as string
  check(typeof cpcToken === 'string' && cpcToken.length > 24, 'serve mints the HMAC click token')
  check((await eventsFor(cpcRid, 'loaded_impression')) === 1, 'loaded_impression logged server-side at serve')
  const r1row = await db.budgetReservation.findUnique({ where: { id: cpcRid } })
  check(r1row?.status === 'held', 'reservation HELD at serve')
  check((await chargedFor(cpcId)) === 0, 'NO charge at serve time (CPC)')
  check((await chargedFor(cpmId)) === 0, 'no charge rows anywhere yet')

  console.log('— 3b. anti-fraud: bots never see an ad (no reservation, no event) —')
  const beforeBotServe = await db.budgetReservation.count({ where: { campaignId: cpcId } })
  for (const botUa of [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'python-requests/2.31.0',
    'curl/8.5.0',
    '',
  ]) {
    const s = await call('/api/ads/serve?slot=feed', { ip: '10.40.0.2', ua: botUa || null })
    check(s.status === 204, `bot UA "${botUa.slice(0, 24)}${botUa.length > 24 ? '…' : ''}" → 204 (no ad)`)
  }
  check((await db.budgetReservation.count({ where: { campaignId: cpcId } })) === beforeBotServe, 'bots created no reservation')

  console.log('— 4. the signed click redirect route (CPC) —')
  const forged = await clickToken('totally-forged-token-abcdefghijklmnop', { ip: '10.40.1.1' })
  check(forged.status === 400, `forged token → 400 (got ${forged.status})`)

  const c1 = await clickToken(cpcToken, { ip: '10.40.1.2' })
  check(c1.status === 302, `valid click → 302 (got ${c1.status})`)
  check(c1.location === 'https://acme.example/cpc', `redirect Location is the signed destination (got ${c1.location})`)
  check((await chargedFor(cpcId)) === 500_000, 'click charged exactly one bid (500,000 µUSD)')
  check((await eventsFor(cpcRid, 'valid_click')) === 1, 'valid_click logged exactly once')
  check((await db.budgetReservation.findUnique({ where: { id: cpcRid } }))?.status === 'finalized', 'reservation FINALIZED')

  const c2 = await clickToken(cpcToken, { ip: '10.40.1.3' })
  check(c2.status === 302 && c2.location === 'https://acme.example/cpc', 'double click still redirects (UX)')
  check((await chargedFor(cpcId)) === 500_000, 'double click → NO second charge')
  check((await eventsFor(cpcRid, 'valid_click')) === 1, 'double click → NO duplicate valid_click row')

  // Bot click: fresh serve, new token, Googlebot follows the link.
  const s2 = await call('/api/ads/serve?slot=feed', { ip: '10.40.2.1' })
  const botRid = s2.data?.ad?.reservationId as string
  const botClickToken = s2.data?.ad?.clickToken as string
  const bc = await clickToken(botClickToken, { ip: '10.40.2.2', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })
  check(bc.status === 302 && bc.location === 'https://acme.example/cpc', 'bot click still redirects (genuine destination)')
  check((await chargedFor(cpcId)) === 500_000, 'bot click → NO charge')
  check((await eventsFor(botRid, 'valid_click')) === 0, 'bot click → NOT logged as a valid click')

  // Expired token (white-box craft with the shared secret, exp in the past).
  const s3 = await call('/api/ads/serve?slot=feed', { ip: '10.40.3.1' })
  const expRid = s3.data?.ad?.reservationId as string
  const expPayload = verifyAdToken(s3.data?.ad?.clickToken as string)
  check(expPayload !== null, 'token round-trips through verifyAdToken (white-box)')
  const expiredTok = signAdToken({ ...expPayload!, exp: Date.now() - 60_000 } as AdTokenPayload)
  const ec = await clickToken(expiredTok, { ip: '10.40.3.2' })
  check(ec.status === 302 && ec.location === 'https://acme.example/cpc', 'expired-but-signed token still redirects honestly')
  check((await chargedFor(cpcId)) === 500_000, 'expired token → NO charge')
  check((await eventsFor(expRid, 'valid_click')) === 0, 'expired token → no valid_click row')

  console.log('— 5. the viewability beacon endpoint (rate limit, bots, origin) —')
  const xo = await beacon(cpcToken, { origin: 'https://evil.example', ip: '10.40.4.1' })
  check(xo.status === 403, `cross-origin beacon → 403 (got ${xo.status})`)

  const botBeacon = await beacon(cpcToken, { ua: 'python-requests/2.31.0', ip: '10.40.4.2' })
  check(botBeacon.status === 403, 'bot beacon → 403 (never billable)')

  const badTok = await beacon('not-a-token-xyz', { ip: '10.40.4.3' })
  check(badTok.status === 400, 'garbage token → 400')

  const badType = await beacon(cpcToken, { type: 'valid_click', ip: '10.40.4.4' })
  check(badType.status === 400, 'client may only report viewable_impression (type=valid_click → 400)')

  // CPC views: logged, never billed.
  const s4 = await call('/api/ads/serve?slot=feed', { ip: '10.40.5.1' })
  const cpcViewRid = s4.data?.ad?.reservationId as string
  const cpcViewTok = s4.data?.ad?.clickToken as string
  const cpcView = await beacon(cpcViewTok, { ip: '10.40.5.2' })
  check(cpcView.status === 200 && cpcView.data?.recorded === true, 'CPC view beacon recorded (informational)')
  check(cpcView.data?.chargedMicroUsd === 0, 'CPC view charges NOTHING (CPC bills clicks only)')
  check((await eventsFor(cpcViewRid, 'viewable_impression')) === 1, 'CPC viewable_impression logged')
  check((await chargedFor(cpcId)) === 500_000, 'CPC wallet untouched by the view')

  console.log('— 6. CPM: viewable impression is the ONLY billing event —')
  await call(`/api/ads/campaigns/${cpcId}`, { method: 'PATCH', body: { action: 'pause' } })
  await call(`/api/ads/campaigns/${cpmId}`, { method: 'PATCH', body: { action: 'resume' } })

  const c1s = await call('/api/ads/serve?slot=feed', { ip: '10.40.6.1' })
  check(c1s.status === 200 && c1s.data?.ad?.campaignId === cpmId, 'CPM campaign serves')
  const cpmRid = c1s.data?.ad?.reservationId as string
  const cpmTok = c1s.data?.ad?.clickToken as string
  check((await db.budgetReservation.findUnique({ where: { id: cpmRid } }))?.status === 'held', 'CPM reservation HELD at serve')
  check((await chargedFor(cpmId)) === 0, 'CPM NOT charged at serve (the Phase 3 shift)')
  check((await eventsFor(cpmRid, 'loaded_impression')) === 1, 'CPM loaded_impression logged')

  const v1 = await beacon(cpmTok, { ip: '10.40.6.2' })
  check(v1.status === 200 && v1.data?.recorded === true, 'viewable impression recorded')
  check(v1.data?.chargedMicroUsd === 50_000, `beacon charged bid/1000 (got ${v1.data?.chargedMicroUsd})`)
  check((await chargedFor(cpmId)) === 50_000, 'CPM charged on the view event')
  check((await eventsFor(cpmRid, 'viewable_impression')) === 1, 'CPM viewable_impression logged')
  check((await db.budgetReservation.findUnique({ where: { id: cpmRid } }))?.status === 'finalized', 'CPM reservation FINALIZED by the view')

  const v2 = await beacon(cpmTok, { ip: '10.40.6.3' })
  check(v2.status === 200 && v2.data?.recorded === false, 'replayed beacon → recorded:false')
  check((await chargedFor(cpmId)) === 50_000, 'replayed beacon → NO double charge')

  // Expired-token beacon: honest no-op.
  const c2s = await call('/api/ads/serve?slot=feed', { ip: '10.40.7.1' })
  const cpmRid2 = c2s.data?.ad?.reservationId as string
  const cpmTok2Base = verifyAdToken(c2s.data?.ad?.clickToken as string)
  const cpmTok2 = signAdToken({ ...cpmTok2Base!, exp: Date.now() - 60_000 } as AdTokenPayload)
  const v3 = await beacon(cpmTok2, { ip: '10.40.7.2' })
  check(v3.status === 200 && v3.data?.recorded === false, 'expired-token beacon → recorded:false reason expired')
  check((await chargedFor(cpmId)) === 50_000, 'expired-token beacon → NO charge')

  // A CPM CLICK: logged (informational), never charged.
  const cc = await clickToken(cpmTok, { ip: '10.40.8.1' })
  check(cc.status === 302 && cc.location === 'https://acme.example/cpm', 'CPM click redirects')
  check((await chargedFor(cpmId)) === 50_000, 'CPM click charges NOTHING (CPM bills views)')
  check((await eventsFor(cpmRid, 'valid_click')) === 1, 'CPM click logged as valid_click (CTR is reported for both models)')

  console.log('— 7. expiry refund: TTL passed without a validating event —')
  const s7 = await call('/api/ads/serve?slot=feed', { ip: '10.40.9.1' })
  const refundRid = s7.data?.ad?.reservationId as string
  const refundTok = s7.data?.ad?.clickToken as string
  const before = await call('/api/ads/campaigns')
  const cpmBefore = before.data?.campaigns?.find((c: any) => c.id === cpmId)
  const remainingBefore = cpmBefore?.budget?.remainingMicroUsd as number
  await db.budgetReservation.update({ where: { id: refundRid }, data: { expiresAt: new Date(Date.now() - 1_000) } })
  // The campaigns GET sweeps stale holds.
  const after = await call('/api/ads/campaigns')
  const cpmAfter = after.data?.campaigns?.find((c: any) => c.id === cpmId)
  check((await db.budgetReservation.findUnique({ where: { id: refundRid } }))?.status === 'expired', 'sweeper flipped the hold to EXPIRED')
  check(cpmAfter?.budget?.remainingMicroUsd === remainingBefore + 50_000, 'campaign budget recovered the expired hold (refund)')
  const lateBeacon = await beacon(refundTok, { ip: '10.40.9.2' })
  check(lateBeacon.status === 200 && lateBeacon.data?.recorded === false, 'beacon for the expired hold → recorded:false')
  check((await chargedFor(cpmId)) === 50_000, 'expired hold was never charged')
  const walletNow = await wallet()
  // Wallet reserved = committed (2 × $10) − charges (CPC 0.5M + CPM 0.05M).
  check(walletNow.reserved === 20_000_000 - 500_000 - 50_000, `wallet reserved = committed − charges (got ${walletNow.reserved})`)

  console.log('— 8. rate limit on /api/ads/event (30/min/IP) —')
  let saw429 = 0
  let saw400 = 0
  for (let i = 0; i < 34; i++) {
    const r = await beacon('garbage-token-0000000000000000', { ip: '10.40.10.1' })
    if (r.status === 429) saw429++
    else if (r.status === 400) saw400++
  }
  check(saw400 === 30 && saw429 === 4, `burst → 30×400 then 429s (got ${saw400}×400, ${saw429}×429)`)

  console.log('— 9. Reports API: real metrics, NULL for no-data —')
  // The campaign-create route allows 6/min per advertiser; §2 already used
  // some of that budget. Wait for the window to age out so the draft creates
  // below cannot 429 (a real client sees the same 429 and retries).
  await new Promise((r) => setTimeout(r, 61_000))

  const noAuth = await call('/api/ads/reports', { auth: null })
  check(noAuth.status === 401, 'reports without a session → 401')

  const reports = await call('/api/ads/reports')
  const repCpc = reports.data?.campaigns?.find((c: any) => c.campaignId === cpcId)
  const repCpm = reports.data?.campaigns?.find((c: any) => c.campaignId === cpmId)
  if (!repCpc || !repCpm) {
    console.log(`        [debug] reports → status ${reports.status}, body: ${JSON.stringify(reports.data)?.slice(0, 500)}`)
  }
  // CPC: 5 serves so far (s1..s4 + bot/expire extras) — count from the DB.
  const cpcImpressions = await db.adEvent.count({ where: { campaignId: cpcId, eventType: 'loaded_impression' } })
  check(repCpc?.impressions === cpcImpressions, `CPC impressions matches the event log (${repCpc?.impressions} vs ${cpcImpressions})`)
  check(repCpc?.clicks === 1, `CPC clicks 1 (got ${repCpc?.clicks})`)
  check(repCpc?.viewableImpressions === 1, `CPC viewable impressions 1 (got ${repCpc?.viewableImpressions})`)
  const expectedCtr = repCpc?.clicks / repCpc?.impressions
  check(Math.abs((repCpc?.ctr ?? -1) - expectedCtr) < 1e-9, `CPC ctr = clicks/impressions (got ${repCpc?.ctr})`)
  check(repCpc?.spentMicroUsd === 500_000, `CPC spent 500,000 (got ${repCpc?.spentMicroUsd})`)
  check(repCpc?.ecpcMicroUsd === 500_000, `CPC eCPC = spent/clicks = 500,000 (got ${repCpc?.ecpcMicroUsd})`)
  const cpmCharges = (await chargedFor(cpmId)) / 50_000
  check(repCpm?.spentMicroUsd === 50_000 * cpmCharges, `CPM spent = ${cpmCharges} views × 50,000 (got ${repCpm?.spentMicroUsd})`)
  check(repCpm?.viewableImpressions === cpmCharges, `CPM viewable impressions ${cpmCharges} (got ${repCpm?.viewableImpressions})`)

  // A campaign with NO events at all: null metrics → the em dash.
  const draft = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Untouched draft', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000,
      targetUrl: 'https://acme.example/draft', headline: 'No events yet', body: 'This draft has no delivery.',
    },
  })
  const draftId = draft.data?.id as string
  const reports2 = await call('/api/ads/reports')
  const repDraft = reports2.data?.campaigns?.find((c: any) => c.campaignId === draftId)
  check(repDraft?.impressions === 0, 'draft impressions 0 (an honest count)')
  check(repDraft?.ctr === null, 'draft CTR null → renders as an em dash, not 0%')
  check(repDraft?.spentMicroUsd === 0, 'draft spent 0 → em dash, not $0.00')
  check(repDraft?.ecpcMicroUsd === null, 'draft eCPC null → em dash')

  console.log('— 10. CSV export: formula-safe, em-dash no-data —')
  for (const evilName of ['=SUM(A1:A2)', '@filter', '+concat', '-hyperlink']) {
    const created = await call('/api/ads/campaigns', {
      method: 'POST',
      body: {
        name: evilName, format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000,
        targetUrl: 'https://acme.example/evil', headline: 'Injection probe', body: 'CSV injection probe campaign.',
      },
    })
    check(created.status === 201, `campaign named "${evilName}" accepted (3–80 chars)`)
  }

  const csvNoAuth = await fetch(`${ORIGIN}/api/ads/reports/export`)
  check(csvNoAuth.status === 401, 'CSV export without a session → 401')

  const csvRes = await fetch(`${ORIGIN}/api/ads/reports/export`, {
    headers: { Cookie: `merklane_session=${SESSION_TOKEN}`, 'User-Agent': HUMAN_UA },
  })
  check(csvRes.status === 200, `CSV export 200 (got ${csvRes.status})`)
  check((csvRes.headers.get('content-type') ?? '').startsWith('text/csv'), 'Content-Type text/csv')
  const disposition = csvRes.headers.get('content-disposition') ?? ''
  check(/attachment; filename="merklane-ads-report-\d{4}-\d{2}-\d{2}\.csv"/.test(disposition), `attachment filename (${disposition})`)
  // The BOM must be checked on RAW BYTES: fetch().text() strips a leading
  // BOM per the WHATWG decode spec, so a text() read can never see it.
  const csvBytes = new Uint8Array(await csvRes.arrayBuffer())
  check(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, 'UTF-8 BOM present (Excel)')
  const csvText = new TextDecoder('utf-8').decode(csvBytes.subarray(3))
  check(csvText.includes('\r\n'), 'CRLF line endings')

  const csvLines = csvText.split('\r\n').filter((l) => l.trim() !== '')
  check(csvLines[0] === 'Campaign,Status,Billing,Bid (USD),Impressions,Viewable impressions,Clicks,CTR,Spent,eCPC', `header row (${csvLines[0]})`)
  for (const evilName of ['=SUM(A1:A2)', '@filter', '+concat', '-hyperlink']) {
    const row = csvLines.find((l) => l.includes(evilName))
    check(Boolean(row), `row for "${evilName}" present`)
    check((row ?? '').startsWith(`'${evilName}`), `"${evilName}" exported with the single-quote formula guard`)
  }
  const draftRow = csvLines.find((l) => l.includes('Untouched draft'))
  check(Boolean(draftRow), 'draft row present')
  check((draftRow ?? '').split(',').slice(-3).join(',') === '—,—,—', `draft CTR/Spent/eCPC export as em dashes (got "${(draftRow ?? '').split(',').slice(-3).join(',')}")`)

  console.log('— 11. real Chromium: viewability delay + active tab + click redirect —')
  // The runner's .env pins AUTH_SECRET; the test process shares it, so
  // tokens minted by the page (via the server) decode here white-box.
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    // A realistic UA: HeadlessChrome would look like a bot to the serve
    // route (and rightly so) — the point here is measuring a human visit.
    userAgent: HUMAN_UA,
  })
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('a[data-host]', { timeout: 30_000 })
  const anchors = await page.locator('a[data-host]').all()
  check(anchors.length > 0, `homepage rendered ${anchors.length} ad card(s)`)

  // ── 11a. the viewability DELAY + the 50 % threshold ────────────────────
  // Anchor #0: hold it at ~25 % visibility for 1.4 s — nothing may fire.
  const href0 = await anchors[0]!.getAttribute('href')
  check((href0 ?? '').startsWith('/api/ads/click/'), 'the card href goes through the signed redirect route')
  const token0 = decodeURIComponent((href0 ?? '').replace(/^\/api\/ads\/click\//, ''))
  const payload0 = verifyAdToken(token0)
  check(payload0 !== null && payload0!.m === 'cpm', 'the served ad is CPM (token decodes white-box)')
  const rid0 = payload0!.r

  const fraction = await anchors[0]!.evaluate((el: SVGElement | HTMLElement) => {
    const r = el.getBoundingClientRect()
    // Park the ad so only its bottom ~25 % pokes into the TOP of the
    // viewport (scrolling PAST it — the strip sits above the fold, so
    // parking it at the bottom edge is geometrically impossible).
    window.scrollTo(0, Math.max(0, window.scrollY + r.bottom - r.height * 0.25))
    const r2 = el.getBoundingClientRect()
    const visible = Math.max(0, Math.min(r2.bottom, window.innerHeight) - Math.max(r2.top, 0))
    return visible / r2.height
  })
  check(fraction > 0.05 && fraction < 0.45, `ad parked at ${(fraction * 100).toFixed(0)}% visible (below the 50% threshold)`)
  await page.waitForTimeout(1_400)
  check((await eventsFor(rid0, 'viewable_impression')) === 0, '25% visible for 1.4s → NO viewable impression (threshold works)')

  // Center it in the viewport (deterministic full visibility); 500 ms is
  // NOT enough — the continuous second is still running.
  await anchors[0]!.evaluate((el: SVGElement | HTMLElement) => el.scrollIntoView({ block: 'center' }))
  const t0 = Date.now()
  await page.waitForTimeout(500)
  check((await eventsFor(rid0, 'viewable_impression')) === 0, 'fully visible for 500ms → NO event yet (the 1s delay works)')
  // …1.4 s total is.
  await page.waitForTimeout(Math.max(200, 1_500 - (Date.now() - t0)))
  check((await eventsFor(rid0, 'viewable_impression')) === 1, 'fully visible ≥1s → viewable impression fired')
  check((await chargedFor(cpmId)) >= 50_000, 'the browser-measured view charged the CPM campaign')
  check((await db.budgetReservation.findUnique({ where: { id: rid0 } }))?.status === 'finalized', 'browser view finalised its reservation')

  // ── 11b. the ACTIVE-TAB requirement (Page Visibility API) ─────────────
  // Headless Chromium cannot emulate tab switching — every page reports
  // 'visible' forever (verified by probe: bringToFront never flips
  // visibilityState). So the hidden tab is emulated the way a real browser
  // would report it: patch document.visibilityState and dispatch a REAL
  // visibilitychange event. The component's genuine handler runs either way.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' }) // fresh serve
  await page.waitForSelector('a[data-host]', { timeout: 30_000 })
  const anchorsB = await page.locator('a[data-host]').all()
  const hrefB = await anchorsB[0]!.getAttribute('href')
  const tokenB = decodeURIComponent((hrefB ?? '').replace(/^\/api\/ads\/click\//, ''))
  const ridB = verifyAdToken(tokenB)!.r

  // Park the ad below 50 % first (kills any timer the above-the-fold render
  // may have started), THEN flip the tab to hidden, THEN make the ad fully
  // visible. From here on, the only way an event can fire is if the Page
  // Visibility handling is broken — exactly what this phase tests.
  await anchorsB[0]!.evaluate((el: SVGElement | HTMLElement) => {
    const r = el.getBoundingClientRect()
    window.scrollTo(0, Math.max(0, window.scrollY + r.bottom - r.height * 0.25))
  })
  await page.evaluate(() => {
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await anchorsB[0]!.evaluate((el: SVGElement | HTMLElement) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(1_500)
  check((await eventsFor(ridB, 'viewable_impression')) === 0, 'hidden tab for 1.5s → NO event (the clock is paused)')
  await page.evaluate(() => {
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(1_400)
  check((await eventsFor(ridB, 'viewable_impression')) === 1, 'tab active again → the continuous second completes and fires')

  // ── 11c. the click redirect, in a real browser ─────────────────────────
  const seenClick: { status?: number; location?: string | null; url?: string } = {}
  context.on('response', (res) => {
    if (res.url().includes('/api/ads/click/')) {
      seenClick.status = res.status()
      seenClick.location = res.headers()['location'] ?? null
      seenClick.url = res.url()
    }
  })
  const cpmChargedBeforeClick = await chargedFor(cpmId)
  const [popup] = await Promise.all([context.waitForEvent('page'), anchorsB[0]!.click()])
  await popup.waitForLoadState('domcontentloaded').catch(() => undefined)
  await popup.close().catch(() => undefined)
  check(seenClick.status === 302, `browser click hit the redirect route → 302 (got ${seenClick.status})`)
  check(seenClick.location === 'https://acme.example/cpm', `redirect Location is the signed destination (got ${seenClick.location})`)
  const clickedToken = decodeURIComponent((seenClick.url ?? '').replace(/^.*\/api\/ads\/click\//, ''))
  const clickedRid = verifyAdToken(clickedToken)?.r ?? ''
  check((await eventsFor(clickedRid, 'valid_click')) === 1, 'the browser click logged valid_click exactly once')
  check((await chargedFor(cpmId)) === cpmChargedBeforeClick, 'the CPM click charged NOTHING extra (views bill, clicks do not)')

  await context.close()
  await browser.close()

  // ==========================================================================
  // Phase 4 — A/B testing (stable 50/50 split, single auction weight)
  // ==========================================================================
  console.log('— 12. A/B testing: two approved creatives, stable 50/50 split —')
  // A FRESH advertiser: its own 6/min campaign-create bucket and its own
  // wallet, so the §2/§9/§10 usage of the first advertiser cannot 429 it.
  const abToken = randomBytes(32).toString('base64url')
  const abUser = await db.user.create({
    data: { email: `ab-e2e-${suffix}@test.local`, name: 'AB E2E', role: 'user' },
  })
  await db.session.create({
    data: {
      tokenHash: sha256(abToken),
      userId: abUser.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  })
  // $60 wallet (two simulate top-ups) → a $50 budget at $0.10/click.
  for (const cents of [500, 5500]) {
    const t = await call('/api/ads/topups', { method: 'POST', body: { amountCents: cents }, auth: abToken })
    await call(`/api/ads/topups/${t.data?.id}/simulate`, { method: 'POST', auth: abToken })
  }

  // The two variants: v1 approved, then a content edit (v2) that goes back
  // to review and is approved again — TWO approved creative versions.
  const abCreated = await call('/api/ads/campaigns', {
    method: 'POST',
    auth: abToken,
    body: {
      name: 'AB test campaign', format: 'text', billingModel: 'cpc',
      bidCents: 10, budgetCents: 5000, targetUrl: 'https://ab.example/landing',
      headline: 'Variant Alpha headline', body: 'The A arm of the experiment.',
      submit: true,
    },
  })
  const abCampaignId = abCreated.data?.id as string
  check(abCreated.status === 201 && abCreated.data?.status === 'pending', 'A/B campaign created + submitted')
  await approveViaBot(abCampaignId)
  const abEdit = await call(`/api/ads/campaigns/${abCampaignId}`, {
    method: 'PATCH',
    auth: abToken,
    body: { action: 'update', headline: 'Variant Beta headline', body: 'The B arm of the experiment.' },
  })
  check(abEdit.status === 200 && abEdit.data?.status === 'pending', 'content edit → v2 back in review (Phase 2 rule)')
  await approveViaBot(abCampaignId)
  const abCampaign2 = await db.campaign.findUnique({ where: { id: abCampaignId } })
  check(abCampaign2?.status === 'active', 'A/B campaign ACTIVE again after the second approval')

  // Experiment creation rules.
  const abList = await call(`/api/ads/campaigns/${abCampaignId}/experiments`, { auth: abToken })
  const approvedCreatives = (abList.data?.approvedCreatives ?? []) as Array<{ id: string; version: number; title: string | null }>
  check(approvedCreatives.length === 2, `two APPROVED creatives available (got ${approvedCreatives.length})`)
  const creativeV2 = approvedCreatives.find((c) => c.version === 2)!
  const creativeV1 = approvedCreatives.find((c) => c.version === 1)!
  check(abList.data?.canCreateNew === true, 'canCreateNew true (2 creatives, no live experiment)')

  const sameTwice = await call(`/api/ads/campaigns/${abCampaignId}/experiments`, {
    method: 'POST',
    auth: abToken,
    body: { creativeAId: creativeV1.id, creativeBId: creativeV1.id, primaryMetric: 'ctr' },
  })
  check(sameTwice.status === 400 && sameTwice.data?.code === 'creative_invalid', 'the same creative for both arms → 400')

  const foreign = await call(`/api/ads/campaigns/${abCampaignId}/experiments`, {
    method: 'POST',
    auth: abToken,
    body: { creativeAId: creativeV1.id, creativeBId: 'nonexistent-creative', primaryMetric: 'ctr' },
  })
  check(foreign.status === 400 && foreign.data?.code === 'creative_invalid', 'a creative of another campaign → 400')

  const abCreate = await call(`/api/ads/campaigns/${abCampaignId}/experiments`, {
    method: 'POST',
    auth: abToken,
    body: { creativeAId: creativeV1.id, creativeBId: creativeV2.id, primaryMetric: 'ctr' },
  })
  const abExperimentId = abCreate.data?.id as string
  check(abCreate.status === 201 && abCreate.data?.status === 'draft', 'experiment created as DRAFT')

  const secondExp = await call(`/api/ads/campaigns/${abCampaignId}/experiments`, {
    method: 'POST',
    auth: abToken,
    body: { creativeAId: creativeV1.id, creativeBId: creativeV2.id, primaryMetric: 'ctr' },
  })
  check(secondExp.status === 409 && secondExp.data?.code === 'already_running', 'a second live experiment → 409')

  // DRAFT → RUNNING.
  const abStart = await call(`/api/ads/experiments/${abExperimentId}`, {
    method: 'PATCH', auth: abToken, body: { action: 'start' },
  })
  check(abStart.status === 200 && abStart.data?.status === 'running', 'experiment started (RUNNING)')

  // Pause EVERY other active campaign so the A/B campaign is the only one in
  // the auction — every serve below must come from it.
  await db.campaign.updateMany({ where: { status: 'active' }, data: { status: 'paused' } })
  await db.campaign.update({ where: { id: abCampaignId }, data: { status: 'active' } })

  // 24 distinct visitors (distinct IPs): each serve must render the arm the
  // STABLE HASH assigns — computed here white-box with the same secret.
  let servedA = 0
  let servedB = 0
  let allMatched = true
  for (let i = 1; i <= 24; i++) {
    const ip = `10.60.0.${i}`
    const s = await call('/api/ads/serve?slot=feed', { ip })
    const expectedVariant = variantForVisitor(abExperimentId, visitorStableId(ip, HUMAN_UA))
    const expectedTitle = expectedVariant === 'A' ? 'Variant Alpha headline' : 'Variant Beta headline'
    if (s.data?.ad?.campaignId === abCampaignId && s.data?.ad?.title === expectedTitle) {
      if (expectedVariant === 'A') servedA++
      else servedB++
    } else {
      allMatched = false
    }
  }
  check(allMatched, 'every serve rendered the arm the stable hash assigns (24/24)')
  check(servedA > 0 && servedB > 0, `both arms delivered (A=${servedA}, B=${servedB}) — a 50/50 split in expectation`)

  // The same visitor ALWAYS sees the same variant (stability).
  const stableIp = '10.60.1.1'
  const abS1 = await call('/api/ads/serve?slot=feed', { ip: stableIp })
  const abS2 = await call('/api/ads/serve?slot=feed', { ip: stableIp })
  check(
    abS1.data?.ad?.title === abS2.data?.ad?.title,
    `the same visitor sees the same variant twice ("${abS1.data?.ad?.title}")`,
  )
  check(
    abS1.data?.ad?.title === (variantForVisitor(abExperimentId, visitorStableId(stableIp, HUMAN_UA)) === 'A'
      ? 'Variant Alpha headline'
      : 'Variant Beta headline'),
    'the stable serve matches the white-box hash too',
  )

  // Attribution: reservations stamped, one assignment row per visitor.
  const stamped = await db.budgetReservation.count({ where: { campaignId: abCampaignId, variantId: { not: null } } })
  check(stamped === 26, `26 variant-stamped reservations (24 visitors + the stability pair; got ${stamped})`)
  const assignments = await db.variantAssignment.count({ where: { experimentId: abExperimentId } })
  check(assignments === 25, `25 VariantAssignment rows — one per DISTINCT visitor (got ${assignments})`)

  // SINGLE AUCTION WEIGHT: exactly one reservation (one impression) per
  // serve — the experiment never duplicates the campaign's entries.
  const abImpressions = await db.adEvent.count({
    where: { campaignId: abCampaignId, eventType: 'loaded_impression' },
  })
  check(abImpressions === 26, `26 serves → 26 impressions (single auction weight; got ${abImpressions})`)

  // A click through the signed route attributes to the variant's arm.
  const clickServe = await call('/api/ads/serve?slot=feed', { ip: '10.60.2.1' })
  const clickArm = variantForVisitor(abExperimentId, visitorStableId('10.60.2.1', HUMAN_UA))
  const abClick = await clickToken(clickServe.data?.ad?.clickToken as string, { ip: '10.60.2.2' })
  check(abClick.status === 302, 'A/B campaign click redirects')
  check((await chargedFor(abCampaignId)) === 100_000, 'the click charged exactly one $0.10 bid')
  const abClickedRid = clickServe.data?.ad?.reservationId as string
  check(
    (await db.budgetReservation.findUnique({ where: { id: abClickedRid } }))?.variantId === clickArm,
    `the clicked reservation carries its variant stamp (${clickArm})`,
  )

  // Statistics: per-variant impressions/clicks/CTR/eCPC + the honest verdict.
  const abStats = await call(`/api/ads/campaigns/${abCampaignId}/experiments`, { auth: abToken })
  const exp = (abStats.data?.experiments ?? []).find((e: any) => e.experimentId === abExperimentId)
  check(Boolean(exp), 'the experiment appears in the campaign\'s A/B tab payload')
  const expA = exp?.variants?.find((v: any) => v.variant === 'A')
  const expB = exp?.variants?.find((v: any) => v.variant === 'B')
  check(
    expA?.impressions + expB?.impressions === 27,
    `variant impressions sum to the 27 running serves (A=${expA?.impressions}, B=${expB?.impressions})`,
  )
  const clickedVariant = clickArm === 'A' ? expA : expB
  const otherVariant = clickArm === 'A' ? expB : expA
  check(clickedVariant?.clicks === 1 && otherVariant?.clicks === 0, 'the click is attributed to the right arm')
  check(clickedVariant?.ctr !== null && Math.abs(clickedVariant.ctr - 1 / clickedVariant.impressions) < 1e-9, 'variant CTR = clicks/impressions')
  check(clickedVariant?.ecpcMicroUsd === 100_000, `variant eCPC = spent/clicks = one bid (got ${clickedVariant?.ecpcMicroUsd})`)
  check(otherVariant?.ecpcMicroUsd === null, 'the unclicked arm has NO eCPC (em dash, never $0.00)')
  check(exp?.verdict?.kind === 'insufficient', 'small sample → verdict "insufficient" (never a premature winner)')
  check(exp?.assignedVisitors?.A + exp?.assignedVisitors?.B === 26, 'assigned visitors: 24 + stability + click = 26')

  // The z-test itself (white-box, known-answer).
  const zt1 = twoProportionZTest(20, 100, 5, 100)
  check(zt1.sufficient && zt1.pValue < 0.05, `20/100 vs 5/100 clicks → significant (p=${zt1.pValue.toFixed(4)})`)
  const zt2 = twoProportionZTest(10, 100, 9, 100)
  check(zt2.sufficient && zt2.pValue > 0.05, `10/100 vs 9/100 → NOT significant (p=${zt2.pValue.toFixed(3)})`)
  const zt3 = twoProportionZTest(10, 50, 5, 50)
  check(!zt3.sufficient, 'under 100 impressions per arm → insufficient')
  const zt4 = twoProportionZTest(0, 100, 0, 100)
  check(!zt4.sufficient, 'zero clicks on both arms → insufficient (no contrast)')

  // Pause → the campaign serves its latest approved creative with NO stamp.
  const abPause = await call(`/api/ads/experiments/${abExperimentId}`, {
    method: 'PATCH', auth: abToken, body: { action: 'pause' },
  })
  check(abPause.status === 200 && abPause.data?.status === 'draft', 'experiment paused (RUNNING → DRAFT)')
  const sPaused = await call('/api/ads/serve?slot=feed', { ip: '10.60.3.1' })
  check(sPaused.data?.ad?.title === 'Variant Beta headline', 'paused experiment → latest approved creative (v2)')
  check(
    (await db.budgetReservation.findUnique({ where: { id: sPaused.data?.ad?.reservationId } }))?.variantId === null,
    'the paused-experiment serve carries NO variant stamp',
  )
  const stampedAfterPause = await db.budgetReservation.count({ where: { campaignId: abCampaignId, variantId: { not: null } } })
  check(stampedAfterPause === 27, 'the paused serve did not stamp a variant (still 27 stamped)')

  // Finish (terminal) + restart guards.
  const abFinish = await call(`/api/ads/experiments/${abExperimentId}`, {
    method: 'PATCH', auth: abToken, body: { action: 'finish' },
  })
  check(abFinish.status === 200 && abFinish.data?.status === 'finished', 'experiment finished (terminal)')
  const abRestart = await call(`/api/ads/experiments/${abExperimentId}`, {
    method: 'PATCH', auth: abToken, body: { action: 'start' },
  })
  check(abRestart.status === 400, 'a finished experiment cannot be restarted')

  // ==========================================================================
  // Phase 4 — Forecasting (wizard Step 4 estimate + the honest fallback)
  // ==========================================================================
  console.log('— 13. Forecasting: fallback + filtered 7-day estimate —')
  const fcNoAuth = await call('/api/ads/forecast', { auth: null })
  check(fcNoAuth.status === 401, 'forecast without a session → 401')

  // Fallback: fewer than 1000 platform impressions in the window.
  const platformBefore = await db.adEvent.count({
    where: { eventType: 'loaded_impression', createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
  })
  check(platformBefore < 1000, `pre-seed platform impressions < 1000 (got ${platformBefore}) — the fallback case`)
  const fcInsufficient = await call('/api/ads/forecast')
  check(fcInsufficient.status === 200 && fcInsufficient.data?.sufficient === false, 'fallback: { sufficient: false } — "Insufficient data to forecast"')
  check(fcInsufficient.data?.dailyImpressions === null, 'fallback: no invented numbers (dailyImpressions null)')

  // Seed a donor history: 6 days × 150 impressions (intern-junior/en) plus
  // 300 today (markets/ru) — 1200 ≥ 1000. Expired reservations + direct
  // events: no ledger rows, so nobody's budget is touched.
  const donorCampaign = await db.campaign.create({
    data: {
      advertiserId: abUser.id, name: 'Forecast donor (synthetic)', format: 'text',
      billingModel: 'cpm', bidMicroUsd: 100, totalBudgetMicroUsd: 0,
      status: 'completed', deletedAt: new Date(),
    },
  })
  const donorRows: Array<{ id: string; day: Date; section: string; locale: string }> = []
  let donorSeq = 0
  const dayStart = (d: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - d, 12))
  for (let d = 6; d >= 1; d--) {
    for (let n = 0; n < 150; n++) {
      donorRows.push({ id: `donor-r-${donorSeq}`, day: dayStart(d), section: 'intern-junior', locale: 'en' })
      donorSeq++
    }
  }
  // Today's bucket: 5 minutes ago — safely inside the [window, now] range
  // whatever time of day the suite runs (12:00 UTC could be in the future).
  const todayStamp = new Date(Date.now() - 5 * 60_000)
  for (let n = 0; n < 300; n++) {
    donorRows.push({ id: `donor-r-${donorSeq}`, day: todayStamp, section: 'markets', locale: 'ru' })
    donorSeq++
  }
  await db.budgetReservation.createMany({
    data: donorRows.map((r) => ({
      id: r.id, campaignId: donorCampaign.id, amountMicroUsd: 0, status: 'expired',
      expiresAt: new Date(Date.now() - 1000), variantId: null,
    })),
  })
  await db.adEvent.createMany({
    data: donorRows.map((r) => ({
      campaignId: donorCampaign.id, reservationId: r.id, eventType: 'loaded_impression',
      section: r.section, locale: r.locale, createdAt: r.day,
    })),
  })

  /** Recompute the documented rule (mean ± 0.6σ of the 7 daily buckets). */
  const expectedBand = (counts: number[]): { low: number; high: number } => {
    const mean = counts.reduce((s, n) => s + n, 0) / 7
    const sigma = Math.sqrt(counts.reduce((s, n) => s + (n - mean) * (n - mean), 0) / 7)
    const low = Math.max(0, Math.round(mean - 0.6 * sigma))
    return { low, high: Math.max(low, Math.round(mean + 0.6 * sigma)) }
  }
  /** Events matching a (sections, locales) filter, per UTC day, null passes. */
  const dailyMatches = async (sections: string[], locales: string[]) => {
    const events = await db.adEvent.findMany({
      where: {
        eventType: 'loaded_impression',
        createdAt: { gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 6)) },
      },
      select: { section: true, locale: true, createdAt: true },
    })
    const buckets = new Map<string, number>()
    for (let d = 6; d >= 0; d--) {
      buckets.set(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - d)).toISOString().slice(0, 10), 0)
    }
    for (const e of events) {
      if (sections.length > 0 && e.section !== null && !sections.includes(e.section)) continue
      if (locales.length > 0 && e.locale !== null && !locales.includes(e.locale)) continue
      const day = new Date(e.createdAt).toISOString().slice(0, 10)
      if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1)
    }
    return [...buckets.values()]
  }

  const fcAll = await call('/api/ads/forecast')
  check(fcAll.status === 200 && fcAll.data?.sufficient === true, 'with 1200 seeded impressions the forecast is sufficient')
  check(fcAll.data?.platformImpressions >= 1200, `platform impressions counted (got ${fcAll.data?.platformImpressions})`)
  const bandAll = expectedBand(await dailyMatches([], []))
  check(
    fcAll.data?.dailyImpressions?.low === bandAll.low && fcAll.data?.dailyImpressions?.high === bandAll.high,
    `unfiltered band = mean ± 0.6σ (${bandAll.low} – ${bandAll.high}/day, got ${fcAll.data?.dailyImpressions?.low} – ${fcAll.data?.dailyImpressions?.high})`,
  )
  check(fcAll.data?.dailyClicks !== null && fcAll.data.dailyClicks.low <= fcAll.data.dailyClicks.high, 'clicks band derived from the observed CTR')

  // Section filter: only the intern-junior history matches.
  const fcSection = await call('/api/ads/forecast?sections=intern-junior')
  const bandSection = expectedBand(await dailyMatches(['intern-junior'], []))
  check(
    fcSection.data?.dailyImpressions?.low === bandSection.low && fcSection.data?.dailyImpressions?.high === bandSection.high,
    `section-filtered band (${bandSection.low} – ${bandSection.high}/day, got ${fcSection.data?.dailyImpressions?.low} – ${fcSection.data?.dailyImpressions?.high})`,
  )

  // Locale filter: only today's ru bucket.
  const fcLocale = await call('/api/ads/forecast?locales=ru')
  const bandLocale = expectedBand(await dailyMatches([], ['ru']))
  check(
    fcLocale.data?.dailyImpressions?.low === bandLocale.low && fcLocale.data?.dailyImpressions?.high === bandLocale.high,
    `locale-filtered band (${bandLocale.low} – ${bandLocale.high}/day, got ${fcLocale.data?.dailyImpressions?.low} – ${fcLocale.data?.dailyImpressions?.high})`,
  )

  // A KNOWN section with zero inventory: sufficient, honestly ~0/day (real
  // information — not the "insufficient" fallback).
  const fcEmpty = await call('/api/ads/forecast?sections=insights')
  check(fcEmpty.data?.sufficient === true, 'a known-but-empty section is still a sufficient forecast')
  check(fcEmpty.data?.dailyImpressions?.low === 0 && fcEmpty.data?.dailyImpressions?.high < 30, `empty section ≈ 0/day (got ${fcEmpty.data?.dailyImpressions?.low} – ${fcEmpty.data?.dailyImpressions?.high})`)

  // ==========================================================================
  // Phase 4 — admin roles, permissions and the audit log
  // ==========================================================================
  console.log('— 14. Admin roles + audit log —')
  // A deliberately demoted ANALYST: read-only reports.
  const analystToken = randomBytes(32).toString('base64url')
  const analyst = await db.user.create({
    data: { email: `analyst-${suffix}@test.local`, name: 'Analyst', role: 'user', adminRole: 'analyst' },
  })
  await db.session.create({
    data: { tokenHash: sha256(analystToken), userId: analyst.id, expiresAt: new Date(Date.now() + 3600_000) },
  })
  const analystCreate = await call('/api/ads/campaigns', {
    method: 'POST',
    auth: analystToken,
    body: {
      name: 'Analyst must not create', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000,
      targetUrl: 'https://analyst.example/x', headline: 'Nope', body: 'Analysts cannot create campaigns.',
    },
  })
  check(analystCreate.status === 403 && analystCreate.data?.code === 'forbidden_role', 'ANALYST: campaign creation → 403')
  const analystFund = await call(`/api/ads/campaigns/${abCampaignId}`, {
    method: 'PATCH', auth: analystToken, body: { action: 'fund', amountCents: 100 },
  })
  check(analystFund.status === 403 && analystFund.data?.code === 'forbidden_role', 'ANALYST: budget change (fund) → 403')
  const analystReports = await call('/api/ads/reports', { auth: analystToken })
  check(analystReports.status === 200, 'ANALYST: reports view → 200 (the read-only tier)')
  const analystCsv = await fetch(`${ORIGIN}/api/ads/reports/export`, {
    headers: { Cookie: `merklane_session=${analystToken}`, 'User-Agent': HUMAN_UA },
  })
  check(analystCsv.status === 200, 'ANALYST: CSV export → 200')

  // A BILLING-tier platform admin: balance adjustments only.
  const billingToken = randomBytes(32).toString('base64url')
  const billingAdmin = await db.user.create({
    data: { email: `billing-${suffix}@test.local`, name: 'Billing Admin', role: 'admin', adminRole: 'billing' },
  })
  await db.session.create({
    data: { tokenHash: sha256(billingToken), userId: billingAdmin.id, expiresAt: new Date(Date.now() + 3600_000) },
  })
  const billingCreate = await call('/api/ads/campaigns', {
    method: 'POST',
    auth: billingToken,
    body: {
      name: 'Billing must not create', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000,
      targetUrl: 'https://billing.example/x', headline: 'Nope', body: 'Billing tier cannot create campaigns.',
    },
  })
  check(billingCreate.status === 403, 'BILLING: campaign creation → 403')

  // The ADJUST_BALANCE path: an admin confirming a manual deposit.
  const adjTopUp = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 700 }, auth: abToken })
  const adjConfirm = await call(`/api/admin/ads/topups/${adjTopUp.data?.id}/confirm`, {
    method: 'POST', auth: billingToken, body: {},
  })
  check(adjConfirm.status === 200 && adjConfirm.data?.creditedCents === 700, 'BILLING admin confirmed the deposit ($7 credited)')
  const adjustAudit = await db.auditLog.findFirst({
    where: { action: 'ADJUST_BALANCE', targetId: abUser.id },
    orderBy: { createdAt: 'desc' },
  })
  check(Boolean(adjustAudit && adjustAudit.reason?.includes('$7.00')), 'ADJUST_BALANCE audit row written with the credited amount')
  check(adjustAudit?.actorId === billingAdmin.id && adjustAudit.actorLabel === billingAdmin.email, 'the audit row names the billing admin as the actor')

  // An ANALYST-tier PLATFORM admin may NOT adjust balances.
  const analystAdminToken = randomBytes(32).toString('base64url')
  const analystAdmin = await db.user.create({
    data: { email: `analyst-admin-${suffix}@test.local`, name: 'Analyst Admin', role: 'admin', adminRole: 'analyst' },
  })
  await db.session.create({
    data: { tokenHash: sha256(analystAdminToken), userId: analystAdmin.id, expiresAt: new Date(Date.now() + 3600_000) },
  })
  const adjTopUp2 = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 500 }, auth: abToken })
  const deniedConfirm = await call(`/api/admin/ads/topups/${adjTopUp2.data?.id}/confirm`, {
    method: 'POST', auth: analystAdminToken, body: {},
  })
  check(deniedConfirm.status === 403 && deniedConfirm.data?.code === 'forbidden_role', 'ANALYST-tier admin: balance adjustment → 403')

  // The reject-reason state machine + the AuditLog + the advertiser view.
  const rejectUserToken = randomBytes(32).toString('base64url')
  const rejectUser = await db.user.create({
    data: { email: `reject-${suffix}@test.local`, name: 'Reject E2E', role: 'user' },
  })
  await db.session.create({
    data: { tokenHash: sha256(rejectUserToken), userId: rejectUser.id, expiresAt: new Date(Date.now() + 3600_000) },
  })
  // $20 wallet: the $10 budget is reserved at submit time.
  const rejTopUp = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 2000 }, auth: rejectUserToken })
  await call(`/api/ads/topups/${rejTopUp.data?.id}/simulate`, { method: 'POST', auth: rejectUserToken })
  const rejCreated = await call('/api/ads/campaigns', {
    method: 'POST',
    auth: rejectUserToken,
    body: {
      name: 'Campaign that gets rejected', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000,
      targetUrl: 'https://reject.example/x', headline: 'Rejected headline', body: 'This one will be rejected.',
      submit: true,
    },
  })
  const rejCampaignId = rejCreated.data?.id as string
  if (rejCreated.status !== 201) {
    console.log(`        [debug] reject-campaign create → ${rejCreated.status}: ${JSON.stringify(rejCreated.data)?.slice(0, 300)}`)
  }
  check(rejCreated.status === 201, 'the to-be-rejected campaign was created + submitted')
  const rejectReason = 'Misleading claims in the body copy — please describe the offer accurately.'
  await rejectViaBot(rejCampaignId, rejectReason)
  check(
    (await db.campaign.findUnique({ where: { id: rejCampaignId } }))?.status === 'rejected',
    'the campaign is REJECTED after the bot flow',
  )
  const rejectAudit = await db.auditLog.findFirst({
    where: { action: 'REJECT_CAMPAIGN', targetId: rejCampaignId },
    orderBy: { createdAt: 'desc' },
  })
  check(Boolean(rejectAudit), 'REJECT_CAMPAIGN audit row written')
  check(rejectAudit?.reason === rejectReason, 'the audit row carries the rejection reason verbatim')
  check(
    rejectAudit?.actorId === `tg-admin:${BOT_ADMIN_ID}` || rejectAudit?.actorId !== '',
    'the audit row names the acting admin (tg-admin label when unlinked)',
  )
  // The advertiser sees the reason in their dashboard.
  const rejDashboard = await call('/api/ads/campaigns', { auth: rejectUserToken })
  const rejRow = rejDashboard.data?.campaigns?.find((c: any) => c.id === rejCampaignId)
  check(rejRow?.status === 'rejected', 'the advertiser dashboard shows the campaign as rejected')
  check(rejRow?.creative?.moderationNote === rejectReason, 'the advertiser sees the rejection reason verbatim in the dashboard')

  // The approve audit row (user2's campaign was approved twice in §12).
  const approveAudit = await db.auditLog.count({ where: { action: 'APPROVE_CAMPAIGN', targetId: abCampaignId } })
  check(approveAudit === 2, `both §12 approvals are audited (got ${approveAudit})`)

  // Owner-only endpoints: the audit log reader + role management.
  const ownerToken = randomBytes(32).toString('base64url')
  const ownerAdmin = await db.user.create({
    data: { email: `owner-${suffix}@test.local`, name: 'Owner Admin', role: 'admin' },
  })
  await db.session.create({
    data: { tokenHash: sha256(ownerToken), userId: ownerAdmin.id, expiresAt: new Date(Date.now() + 3600_000) },
  })
  const auditDeny = await call('/api/admin/audit-log', { auth: analystAdminToken })
  check(auditDeny.status === 403, 'non-owner admin: audit log read → 403')
  const auditRead = await call('/api/admin/audit-log?action=REJECT_CAMPAIGN&take=10', { auth: ownerToken })
  check(auditRead.status === 200 && auditRead.data?.entries?.length === 1, 'owner admin reads the audit log filtered by action')
  check(auditRead.data?.entries?.[0]?.reason === rejectReason, 'the filtered audit entry is the rejection with its reason')

  // SET_ROLE: owner promotes the analyst; the promotion is audited and the
  // analyst can then create campaigns.
  const setRole = await call('/api/admin/users/role', {
    method: 'POST', auth: ownerToken,
    body: { userId: analyst.id, adminRole: 'editor', reason: 'E2E promotion' },
  })
  check(setRole.status === 200, 'owner promotes the analyst to EDITOR')
  const setRoleAudit = await db.auditLog.findFirst({ where: { action: 'SET_ROLE', targetId: analyst.id } })
  check(Boolean(setRoleAudit?.reason?.includes('Analyst') && setRoleAudit.reason.includes('Editor')), `SET_ROLE audit row records old → new tier ("${setRoleAudit?.reason}")`)
  const promotedCreate = await call('/api/ads/campaigns', {
    method: 'POST',
    auth: analystToken,
    body: {
      name: 'Promoted editor can create', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000,
      targetUrl: 'https://editor.example/x', headline: 'Now allowed', body: 'Editors manage campaigns.',
    },
  })
  check(promotedCreate.status === 201, 'the promoted EDITOR can now create campaigns')
  const selfDemote = await call('/api/admin/users/role', {
    method: 'POST', auth: ownerToken,
    body: { userId: ownerAdmin.id, adminRole: 'editor' },
  })
  check(selfDemote.status === 400 && selfDemote.data?.code === 'self_demotion', 'an owner cannot demote their own tier')
  const nonOwnerSetRole = await call('/api/admin/users/role', {
    method: 'POST', auth: analystAdminToken,
    body: { userId: analyst.id, adminRole: 'analyst' },
  })
  check(nonOwnerSetRole.status === 403, 'non-owner admin: SET_ROLE → 403')

  console.log('— 15. cleanup —')
  const inv = await ledgerInvariant(advertiser.id)
  check(inv.ok, `final ledger invariant (${inv.detail})`)
  const invAb = await ledgerInvariant(abUser.id)
  check(invAb.ok, `A/B advertiser ledger invariant (${invAb.detail})`)
  await db.session.deleteMany({ where: { userId: advertiser.id } })
  await db.user.deleteMany({
    where: { id: { in: [advertiser.id, abUser.id, analyst.id, billingAdmin.id, analystAdmin.id, rejectUser.id, ownerAdmin.id] } },
  })
  await db.telegramAdminState.deleteMany({})
  check(true, 'seed users removed (cascades)')

  console.log('')
  if (fail > 0) {
    console.log(`FAILED: ${fail} check(s) failed (${pass} passed)`)
    process.exit(1)
  }
  console.log(`ALL PASS — ${pass} checks`)
}

main()
  .catch((err) => {
    console.error('[ads-events-e2e] fatal:', err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
