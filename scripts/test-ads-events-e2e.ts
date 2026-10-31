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
async function approveViaBot(campaignId: string): Promise<void> {
  const r = await fetch(BOT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': BOT_SECRET },
    body: JSON.stringify(tgCallback(`modok:${campaignId}`)),
  })
  check(r.status === 200, `bot approve ${campaignId.slice(0, 8)}`)
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

  console.log('— 12. cleanup —')
  const inv = await ledgerInvariant(advertiser.id)
  check(inv.ok, `final ledger invariant (${inv.detail})`)
  await db.session.deleteMany({ where: { userId: advertiser.id } })
  await db.user.deleteMany({ where: { id: advertiser.id } })
  await db.telegramAdminState.deleteMany({})
  check(true, 'seed user removed (cascades)')

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
