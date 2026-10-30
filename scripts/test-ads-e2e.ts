/**
 * Merklane Ads Phase 1 — HTTP end-to-end test (double-entry wallet, CPC/CPM).
 *
 * Drives the FULL advertiser journey against a live dev server:
 *   wallet deposit (derived address, ADS_TOPUP_MODE=simulate) → simulate
 *   confirm → CREDIT ledger row → CPC text campaign created + funded FROM
 *   the wallet (starts ACTIVE) → serve holds a 30-minute BudgetReservation
 *   → click finalises it (CHARGE) → hold expiry refunds the campaign budget
 *   → CPM banner campaign charged per view with a DAILY cap → drain →
 *   resume out-of-budget rejection → content edit appends creative v2 →
 *   locale targeting → add funds (RESERVE) → delete (REFUND).
 * Plus the security rails: auth gate, CSRF, cross-origin block, foreign
 * top-up invisibility, and the wallet ledger invariant
 * (available + reserved == Σcredit − Σcharge).
 *
 * The test seeds its own user + session + csrf cookie directly in the
 * database (sqlite), then talks HTTP only — plus a handful of white-box
 * reads of the reservation/ledger tables through the same Prisma client.
 *
 * Run via: bash scripts/run-ads-e2e.sh  (spawns the dev server on :3103)
 */
import { PrismaClient } from '@prisma/client'
import { createHash, randomBytes } from 'node:crypto'

const ORIGIN = (process.env.BASE_URL ?? 'http://localhost:3103').replace(/\/+$/, '')
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

const CSRF = randomBytes(24).toString('base64url')
const SESSION_TOKEN = randomBytes(32).toString('base64url')
const ADMIN_SESSION_TOKEN = randomBytes(32).toString('base64url')

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; auth?: string | null; origin?: string; ip?: string } = {},
): Promise<{ status: number; data: any }> {
  const auth = opts.auth !== undefined ? opts.auth : SESSION_TOKEN
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: opts.origin ?? ORIGIN,
  }
  if (opts.ip) headers['X-Forwarded-For'] = opts.ip
  // Mutations always echo the double-submit CSRF token (with or without body).
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
  // Unwrap the { ok, data } envelope the same way the browser api() client
  // does — errors keep their `error` message on the result.
  let data: any = null
  try {
    const body = await res.json()
    data = body && typeof body === 'object' && 'data' in body ? body.data : body
  } catch {
    data = null
  }
  return { status: res.status, data }
}

async function wallet(): Promise<{ available: number; reserved: number; pending: number; raw: any }> {
  const w = await call('/api/ads/wallet')
  return {
    available: w.data?.availableMicroUsd ?? -1,
    reserved: w.data?.reservedMicroUsd ?? -1,
    pending: w.data?.pendingCents ?? -1,
    raw: w.data,
  }
}

/** White-box: the double-entry invariant available + reserved == Σcredit − Σcharge. */
async function ledgerInvariant(userId: string): Promise<{ ok: boolean; detail: string }> {
  const w = await db.wallet.findFirst({ where: { userId } })
  if (!w) return { ok: false, detail: 'no wallet' }
  const rows = await db.ledgerEntry.groupBy({
    by: ['type'],
    where: { walletId: w.id },
    _sum: { amountMicroUsd: true },
  })
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

async function main(): Promise<void> {
  console.log('— 0. seed: advertiser + admin (direct DB) —')
  const suffix = Date.now()
  const advertiser = await db.user.create({
    data: { email: `ads-e2e-${suffix}@test.local`, name: 'Ads E2E', role: 'user' },
  })
  const admin = await db.user.create({
    data: { email: `ads-admin-${suffix}@test.local`, name: 'Ads Admin', role: 'admin' },
  })
  const session = await db.session.create({
    data: {
      tokenHash: sha256(SESSION_TOKEN),
      userId: advertiser.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  })
  await db.session.create({
    data: {
      tokenHash: sha256(ADMIN_SESSION_TOKEN),
      userId: admin.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  })
  check(Boolean(advertiser.id && session.id && admin.id), 'advertiser + admin + sessions seeded')

  console.log('— 1. auth & CSRF rails —')
  const noAuth = await call('/api/ads/campaigns', { auth: null })
  check(noAuth.status === 401, `campaigns without session → 401 (got ${noAuth.status})`)

  const noCsrf = await fetch(`${ORIGIN}/api/ads/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: `merklane_session=${SESSION_TOKEN}` },
    body: JSON.stringify({ name: 'x', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000, targetUrl: 'https://a.b', headline: 'h', body: 'b' }),
  })
  check(noCsrf.status === 403, `POST without CSRF cookie/header → 403 (got ${noCsrf.status})`)

  const crossOrigin = await call('/api/ads/campaigns', {
    method: 'POST',
    origin: 'https://evil.example',
    body: { name: 'x', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000, targetUrl: 'https://a.b', headline: 'h', body: 'b' },
  })
  check(crossOrigin.status === 403, `cross-origin POST blocked (got ${crossOrigin.status})`)

  console.log('— 2. campaign validation & wallet gate —')
  const badUrl = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { name: 'Valid name', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000, targetUrl: 'http://insecure.example', headline: 'Valid', body: 'Valid' },
  })
  check(badUrl.status === 400, 'http:// (non-https) destination rejected')

  const noImage = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { name: 'Valid name', format: 'banner', billingModel: 'cpm', bidCents: 200, budgetCents: 1000, targetUrl: 'https://acme.example', headline: 'Valid headline', body: 'Valid body copy' },
  })
  check(
    noImage.status === 400 && noImage.data?.code === 'creative_missing',
    'banner campaign without an image URL → 400 creative_missing',
  )

  const noFunds = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { name: 'Valid name', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000, targetUrl: 'https://acme.example', headline: 'Valid', body: 'Valid' },
  })
  check(
    noFunds.status === 400 && noFunds.data?.code === 'insufficient_wallet',
    'campaign create with an empty wallet → 400 insufficient_wallet',
  )

  console.log('— 3. serve answers 204 with no eligible campaign —')
  const serveEmpty = await fetch(`${ORIGIN}/api/ads/serve?slot=home_banner`, {
    headers: { 'X-Forwarded-For': '10.20.0.0' },
  })
  check(serveEmpty.status === 204, `serve with no eligible campaign → 204 (got ${serveEmpty.status})`)

  console.log('— 4. wallet deposit (simulate mode) → CREDIT ledger row —')
  const tooSmall = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 100 } })
  check(tooSmall.status === 400, 'deposit below $5 minimum rejected')

  const topUp = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 500 } })
  check(topUp.status === 201, `deposit intention created (got ${topUp.status})`)
  const topUpId = topUp.data?.id as string
  check(/^0x[0-9a-f]{40}$/.test(topUp.data?.walletAddress ?? ''), 'derived deposit address is 0x + 40 hex')
  check(topUp.data?.amountExpectedCents === 500, 'expected amount echoed (500 cents)')

  const topUpStatus = await call(`/api/ads/topups/${topUpId}`)
  check(topUpStatus.data?.status === 'pending', 'polling shows pending')

  const foreignTopUp = await call(`/api/ads/topups/${topUpId}`, { auth: ADMIN_SESSION_TOKEN })
  check(foreignTopUp.status === 404, "another user's top-up is invisible (404)")

  const pendingWallet = await wallet()
  check(pendingWallet.pending === 500, 'wallet tab counts the pending deposit')

  const sim = await call(`/api/ads/topups/${topUpId}/simulate`, { method: 'POST' })
  if (!(sim.status === 200 && sim.data?.status === 'confirmed')) {
    console.log(`        [debug] simulate → ${sim.status}: ${JSON.stringify(sim.data)}`)
  }
  check(sim.status === 200 && sim.data?.status === 'confirmed', 'simulate confirms the deposit')
  check(sim.data?.creditedCents === 500, 'credited 500 cents')

  const simAgain = await call(`/api/ads/topups/${topUpId}/simulate`, { method: 'POST' })
  check(simAgain.status === 400, 'double-confirmation rejected (idempotent)')

  const fundedWallet = await wallet()
  check(fundedWallet.available === 5_000_000, `wallet credited 5,000,000 µUSD (got ${fundedWallet.available})`)
  const creditRow = fundedWallet.raw?.ledger?.find((l: any) => l.eventId === `topup:${topUpId}`)
  check(
    creditRow?.type === 'credit' && creditRow?.amountMicroUsd === 5_000_000,
    'ledger shows the CREDIT row (eventId topup:<id>, +5,000,000 µUSD)',
  )

  // Second deposit so the first campaign's budget is fully covered.
  const topUp2 = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 1500 } })
  const sim2 = await call(`/api/ads/topups/${topUp2.data?.id}/simulate`, { method: 'POST' })
  check(sim2.data?.status === 'confirmed', 'wallet topped up to $20 (1,500¢ more)')

  console.log('— 5. CPC text campaign created + funded FROM the wallet (starts ACTIVE) —')
  const created = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Acme hiring — CPC',
      format: 'text',
      billingModel: 'cpc',
      bidCents: 50, // $0.50 per click
      budgetCents: 1000, // $10.00 total
      dailyBudgetCents: 0,
      targetUrl: 'https://acme.example/hiring',
      headline: 'Hire Web3 engineers on Acme',
      body: 'Reach 40k+ monthly Web3 job seekers.',
    },
  })
  check(created.status === 201, `campaign created 201 (got ${created.status})`)
  const campaignId = created.data?.id as string
  check(created.data?.status === 'active', 'funded campaign starts ACTIVE')

  const spentWallet = await wallet()
  check(spentWallet.available === 10_000_000, `wallet available 10,000,000 µUSD (got ${spentWallet.available})`)
  check(spentWallet.reserved === 10_000_000, `wallet reserved 10,000,000 µUSD (got ${spentWallet.reserved})`)

  let list = await call('/api/ads/campaigns')
  let campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.budget?.remainingMicroUsd === 10_000_000, `campaign remaining budget 10,000,000 µUSD (got ${campaign?.budget?.remainingMicroUsd})`)
  check(campaign?.budget?.committedMicroUsd === 10_000_000, 'committed mirrors the reserve')
  const reserveRow = spentWallet.raw?.ledger?.find((l: any) => l.campaignId === campaignId && l.type === 'reserve')
  check(reserveRow?.amountMicroUsd === -10_000_000, 'ledger shows the RESERVE row (−10,000,000 µUSD)')

  console.log('— 6. CPC serve: one bid held for 30 minutes (no charge yet) —')
  const served = await call('/api/ads/serve?slot=feed', { ip: '10.20.0.1' })
  check(served.status === 200 && served.data?.ad?.campaignId === campaignId, 'serve returns the active campaign')
  const reservationId = served.data?.ad?.reservationId as string
  check(typeof reservationId === 'string' && reservationId.length > 0, 'reservation id issued')
  check(served.data?.ad?.format === 'text', 'ad format is text')
  check(served.data?.ad?.billingModel === 'cpc', 'ad billing model echoed')
  check(served.data?.ad?.targetHost === 'acme.example', 'target host extracted for the card')

  const heldRow = await db.budgetReservation.findUnique({ where: { id: reservationId } })
  check(heldRow?.status === 'held' && heldRow?.amountMicroUsd === 500_000, 'DB: reservation HELD for one bid (500,000 µUSD)')
  check(
    Boolean(heldRow && heldRow.expiresAt.getTime() > Date.now() + 29 * 60_000),
    `DB: hold expires in ~30 minutes (${heldRow?.expiresAt.toISOString()})`,
  )

  // The hold does NOT move wallet money — only the campaign's derived budget.
  const heldWallet = await wallet()
  check(heldWallet.reserved === 10_000_000, 'wallet untouched while the hold is in flight')

  list = await call('/api/ads/campaigns')
  campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.budget?.heldMicroUsd === 500_000, `campaign budget shows the in-flight hold (got ${campaign?.budget?.heldMicroUsd})`)
  check(campaign?.budget?.remainingMicroUsd === 9_500_000, `remaining = committed − spent − held (got ${campaign?.budget?.remainingMicroUsd})`)
  check(campaign?.stats?.served === 1, `served count 1 (got ${campaign?.stats?.served})`)

  console.log('— 7. click: hold finalised, wallet charged —')
  const badClick = await call('/api/ads/click', { method: 'POST', body: { reservationId: 'nonexistent' }, ip: '10.20.0.2' })
  check(badClick.data?.recorded === false, 'click on unknown reservation ignored')

  const click = await call('/api/ads/click', { method: 'POST', body: { reservationId }, ip: '10.20.0.2' })
  check(click.data?.recorded === true, 'valid click recorded')
  check(click.data?.chargedMicroUsd === 500_000, 'click charged one bid (500,000 µUSD)')

  const clickAgain = await call('/api/ads/click', { method: 'POST', body: { reservationId }, ip: '10.20.0.2' })
  check(clickAgain.data?.recorded === false, 'double click on the same reservation is a no-op')

  const chargedWallet = await wallet()
  check(chargedWallet.reserved === 9_500_000, `wallet reserved dropped to 9,500,000 µUSD (got ${chargedWallet.reserved})`)
  const chargeRow = chargedWallet.raw?.ledger?.find((l: any) => l.eventId === `charge:${reservationId}`)
  check(
    chargeRow?.type === 'charge' && chargeRow?.amountMicroUsd === -500_000,
    'ledger shows the CHARGE row (eventId charge:<rid>, −500,000 µUSD)',
  )

  list = await call('/api/ads/campaigns')
  campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.stats?.clicks === 1, `click visible in dashboard (got ${campaign?.stats?.clicks})`)
  check(campaign?.budget?.spentMicroUsd === 500_000, `spent 500,000 µUSD (got ${campaign?.budget?.spentMicroUsd})`)
  let inv = await ledgerInvariant(advertiser.id)
  check(inv.ok, `ledger invariant after the charge (${inv.detail})`)

  console.log('— 8. hold expiry: unclicked CPC hold refunds the CAMPAIGN budget —')
  const served2 = await call('/api/ads/serve?slot=feed', { ip: '10.20.0.3' })
  const rid2 = served2.data?.ad?.reservationId as string
  check(Boolean(rid2), 'second serve issued another hold')
  // Fast-forward the hold past its window (white-box, like the rest of the
  // seeding), then read the dashboard — the GET sweeps stale holds.
  await db.budgetReservation.update({ where: { id: rid2 }, data: { expiresAt: new Date(Date.now() - 1_000) } })
  const afterSweep = await call('/api/ads/campaigns')
  campaign = afterSweep.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.budget?.heldMicroUsd === 0, 'expired hold no longer counts as in-flight')
  check(campaign?.budget?.remainingMicroUsd === 9_500_000, 'campaign budget recovered the expired hold')
  const sweptRow = await db.budgetReservation.findUnique({ where: { id: rid2 } })
  check(sweptRow?.status === 'expired', 'DB: reservation flipped to expired by the sweeper')

  const lateClick = await call('/api/ads/click', { method: 'POST', body: { reservationId: rid2 }, ip: '10.20.0.4' })
  check(lateClick.data?.recorded === false, 'click on an expired hold is rejected (not a valid click)')

  console.log('— 9. CPM banner campaign: charged per view, stopped by the DAILY cap —')
  // $50 CPM → 50,000 µUSD per view; the $1.00 daily cap admits exactly
  // 20 views, while the $10 total budget would allow 200 — proving the DAILY
  // rule (not the total) is what stops serving.
  const cpmCreated = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Acme brand banner — CPM',
      format: 'banner',
      billingModel: 'cpm',
      bidCents: 5000, // $50.00 per 1000 views → 50,000 µUSD per view
      budgetCents: 1000, // $10.00 total
      dailyBudgetCents: 100, // $1.00 per UTC day → binds after exactly 20 views
      targetUrl: 'https://acme.example/brand',
      imageUrl: 'https://cdn.acme.example/banner.png',
    },
  })
  check(cpmCreated.status === 201, `CPM banner campaign created (got ${cpmCreated.status})`)
  const cpmId = cpmCreated.data?.id as string
  check(cpmCreated.data?.status === 'active', 'CPM campaign starts ACTIVE')

  // Pause the CPC campaign so the CPM pool is the only competitor.
  const pauseFirst = await call(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { action: 'pause' } })
  check(pauseFirst.data?.status === 'paused', 'CPC campaign paused for a deterministic CPM run')

  let cpmServed = 0
  let sawBanner = false
  for (let i = 0; i < 21; i++) {
    const s = await call('/api/ads/serve?slot=feed', { ip: `10.21.0.${i + 1}` })
    if (s.status === 200) {
      cpmServed++
      if (s.data?.ad?.format === 'banner' && s.data?.ad?.imageUrl?.includes('acme')) sawBanner = true
    }
  }
  check(cpmServed === 20, `exactly 20 views charged before the daily cap (got ${cpmServed})`)
  check(sawBanner, 'served ad carries the banner creative (format + imageUrl)')

  list = await call('/api/ads/campaigns')
  const cpmCampaign = list.data?.campaigns?.find((c: any) => c.id === cpmId)
  check(cpmCampaign?.stats?.views === 20, `20 views recorded (got ${cpmCampaign?.stats?.views})`)
  check(cpmCampaign?.budget?.spentMicroUsd === 1_000_000, `spent 20 × 50,000 = 1,000,000 µUSD (got ${cpmCampaign?.budget?.spentMicroUsd})`)
  check(cpmCampaign?.budget?.spentTodayMicroUsd === 1_000_000, 'daily spend counter at the cap')
  check(cpmCampaign?.budget?.remainingMicroUsd === 9_000_000, 'total budget still has $9 left — only the DAY is capped')
  // CPM reservations are born FINALISED (Phase 1: serve = confirmed view).
  const cpmRes = await db.budgetReservation.findFirst({ where: { campaignId: cpmId } })
  check(cpmRes?.status === 'finalized' && cpmRes?.amountMicroUsd === 50_000, 'DB: CPM reservation born FINALIZED at 50,000 µUSD/view')

  const cpmWallet = await wallet()
  // reserved = c1 remainder (9.5M) + c2 creation (10M) − the 20 CPM charges (1M)
  check(cpmWallet.reserved === 18_500_000, `wallet reserved after the CPM charges (got ${cpmWallet.reserved})`)
  inv = await ledgerInvariant(advertiser.id)
  check(inv.ok, `ledger invariant after the CPM run (${inv.detail})`)

  console.log('— 10. CPC drain: every hold clicked, resume out-of-budget rejected —')
  const drainTopUp = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 500 } })
  const drainSim = await call(`/api/ads/topups/${drainTopUp.data?.id}/simulate`, { method: 'POST' })
  check(drainSim.data?.status === 'confirmed', 'wallet recharged ($5)')

  const pauseCpm = await call(`/api/ads/campaigns/${cpmId}`, { method: 'PATCH', body: { action: 'pause' } })
  check(pauseCpm.data?.status === 'paused', 'CPM campaign paused so the drain is deterministic')

  const drainCreated = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Drain campaign',
      format: 'text',
      billingModel: 'cpc',
      bidCents: 10, // $0.10 per click
      budgetCents: 200, // $2.00 = the 20-event minimum at this bid
      targetUrl: 'https://drain.example',
      headline: 'Drain me',
      body: 'Twenty clicks and done.',
    },
  })
  check(drainCreated.status === 201, `drain campaign created (got ${drainCreated.status})`)
  const drainId = drainCreated.data?.id as string

  // Impressions come from DISTINCT visitors in production — rotate the
  // client IP so the per-IP serve/click limits model many visitors.
  let drainClicks = 0
  for (let i = 0; i < 22; i++) {
    const s = await call('/api/ads/serve?slot=feed', { ip: `10.23.${Math.floor(i / 20)}.${(i % 20) + 1}` })
    if (s.status !== 200) break
    const c = await call('/api/ads/click', {
      method: 'POST',
      body: { reservationId: s.data.ad.reservationId },
      ip: `10.24.${Math.floor(i / 20)}.${(i % 20) + 1}`,
    })
    if (c.data?.recorded === true) drainClicks++
  }
  check(drainClicks === 20, `exactly 20 clicks charged before drain (got ${drainClicks})`)

  list = await call('/api/ads/campaigns')
  const drained = list.data?.campaigns?.find((c: any) => c.id === drainId)
  check(drained?.budget?.remainingMicroUsd === 0, `drain campaign remaining 0 (got ${drained?.budget?.remainingMicroUsd})`)
  check(drained?.stats?.clicks === 20, `drain campaign logged 20 clicks (got ${drained?.stats?.clicks})`)

  const serveDrained = await call('/api/ads/serve?slot=feed', { ip: '10.25.0.1' })
  check(serveDrained.status === 204, 'serve after drain → 204 (out of budget filter)')

  const resumeEmpty = await call(`/api/ads/campaigns/${drainId}`, { method: 'PATCH', body: { action: 'resume' } })
  check(
    resumeEmpty.status === 400 && resumeEmpty.data?.code === 'out_of_budget',
    'resume with an empty budget → 400 out_of_budget',
  )

  console.log('— 11. content edit appends creative v2 + locale targeting —')
  const resumeFirst = await call(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { action: 'resume' } })
  check(resumeFirst.data?.status === 'active', 'CPC campaign resumed')

  const edit = await call(`/api/ads/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: {
      action: 'update',
      headline: 'Hire Web3 engineers on Acme — v2',
      targetLocales: ['ru'],
    },
  })
  check(edit.data?.status === 'updated' && edit.data?.version === 2, 'update appends creative version 2')

  list = await call('/api/ads/campaigns')
  campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.creative?.version === 2, 'dashboard serves creative v2')
  check(campaign?.creative?.title?.includes('v2'), 'v2 headline stored')
  const v2Count = await db.creative.count({ where: { campaignId } })
  check(v2Count === 2, 'creative history is append-only (2 rows)')

  const wrongLocale = await call('/api/ads/serve?slot=feed&locale=en', { ip: '10.26.0.1' })
  check(wrongLocale.status === 204, 'locale the campaign does NOT target → 204')

  const rightLocale = await call('/api/ads/serve?slot=feed&locale=ru', { ip: '10.26.0.2' })
  check(
    rightLocale.status === 200 && rightLocale.data?.ad?.campaignId === campaignId && rightLocale.data?.ad?.title?.includes('v2'),
    'locale match → campaign served with the v2 creative',
  )
  // The Russian serve holds a bid — expire-check it in the next section.

  console.log('— 12. add funds (RESERVE) + delete (REFUND) —')
  const fundTopUp = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 500 } })
  const fundSim = await call(`/api/ads/topups/${fundTopUp.data?.id}/simulate`, { method: 'POST' })
  check(fundSim.data?.status === 'confirmed', 'wallet recharged for the fund tests')

  const tinyFund = await call(`/api/ads/campaigns/${drainId}`, {
    method: 'PATCH',
    body: { action: 'fund', amountCents: 50 },
  })
  check(tinyFund.status === 400 && tinyFund.data?.code === 'amount_too_small', 'fund below $1 minimum rejected')

  const overFund = await call(`/api/ads/campaigns/${drainId}`, {
    method: 'PATCH',
    body: { action: 'fund', amountCents: 5000 },
  })
  check(overFund.status === 400 && overFund.data?.code === 'insufficient_wallet', 'fund beyond the wallet rejected')

  const preFundWallet = await wallet()
  const fund = await call(`/api/ads/campaigns/${drainId}`, {
    method: 'PATCH',
    body: { action: 'fund', amountCents: 200 },
  })
  check(fund.status === 200, `fund accepted (got ${fund.status})`)
  list = await call('/api/ads/campaigns')
  const funded = list.data?.campaigns?.find((c: any) => c.id === drainId)
  check(funded?.totalBudgetMicroUsd === 4_000_000, `total budget grew to $4.00 (got ${funded?.totalBudgetMicroUsd})`)
  check(funded?.budget?.remainingMicroUsd === 2_000_000, `refilled remaining $2.00 (got ${funded?.budget?.remainingMicroUsd})`)
  const postFundWallet = await wallet()
  check(
    postFundWallet.available === preFundWallet.available - 2_000_000,
    `wallet available dropped by the funded amount (${preFundWallet.available} → ${postFundWallet.available})`,
  )

  const destroy = await call(`/api/ads/campaigns/${drainId}`, {
    method: 'PATCH',
    body: { action: 'delete' },
  })
  check(destroy.status === 200 && destroy.data?.status === 'deleted', 'delete accepted')
  list = await call('/api/ads/campaigns')
  const deleted = list.data?.campaigns?.find((c: any) => c.id === drainId)
  check(deleted?.deletedAt !== null && deleted?.status === 'completed', 'campaign soft-deleted (deletedAt + completed)')
  check(deleted?.budget?.remainingMicroUsd === 0, 'deleted campaign has no spendable budget left')

  const postDeleteWallet = await wallet()
  check(
    postDeleteWallet.available === postFundWallet.available + 2_000_000,
    `unspent budget refunded to the wallet (+2,000,000 µUSD → ${postDeleteWallet.available})`,
  )
  const refundRow = postDeleteWallet.raw?.ledger?.find((l: any) => l.eventId === `refund:${drainId}`)
  check(
    refundRow?.type === 'refund' && refundRow?.amountMicroUsd === 2_000_000,
    'ledger shows the REFUND row (eventId refund:<id>, +2,000,000 µUSD)',
  )

  const doubleDelete = await call(`/api/ads/campaigns/${drainId}`, {
    method: 'PATCH',
    body: { action: 'delete' },
  })
  check(doubleDelete.status === 400, 'double delete rejected')

  // The deleted campaign never serves again (its ru-targeted sibling is
  // mid-flight — an en serve must come back empty).
  const serveAfterDelete = await call('/api/ads/serve?slot=feed&locale=en', { ip: '10.27.0.1' })
  check(serveAfterDelete.status === 204, 'serve after delete → 204 (nothing eligible)')

  inv = await ledgerInvariant(advertiser.id)
  check(inv.ok, `final ledger invariant (${inv.detail})`)

  console.log('— 13. pages —')
  const adsPageAnon = await fetch(`${ORIGIN}/ads`, { redirect: 'manual' })
  check(adsPageAnon.status === 307, `/ads redirects to the dashboard (got ${adsPageAnon.status})`)
  const adsPageAuth = await fetch(`${ORIGIN}/ads`, {
    headers: { Cookie: `merklane_session=${SESSION_TOKEN}` },
    redirect: 'manual',
  })
  check(
    adsPageAuth.status === 307 && (adsPageAuth.headers.get('location') ?? '').includes('/profile/ads'),
    `/ads signed in → 307 to /profile/ads (got ${adsPageAuth.status} → ${adsPageAuth.headers.get('location')})`,
  )
  const dashboardAnon = await fetch(`${ORIGIN}/profile/ads`, { redirect: 'manual' })
  check(dashboardAnon.status === 307, `/profile/ads anonymous → 307 to login (got ${dashboardAnon.status})`)
  const dashboardAuth = await fetch(`${ORIGIN}/profile/ads`, {
    headers: { Cookie: `merklane_session=${SESSION_TOKEN}` },
    redirect: 'manual',
  })
  check(dashboardAuth.status === 200, `/profile/ads signed in → 200 (got ${dashboardAuth.status})`)

  console.log('— 14. cleanup —')
  await db.session.deleteMany({ where: { userId: { in: [advertiser.id, admin.id] } } })
  await db.user.deleteMany({ where: { id: { in: [advertiser.id, admin.id] } } })
  check(true, 'seed users removed (wallet/ledger/campaigns cascade)')

  console.log('')
  if (fail > 0) {
    console.log(`FAILED: ${fail} check(s) failed (${pass} passed)`)
    process.exit(1)
  }
  console.log(`ALL PASS — ${pass} checks`)
}

main()
  .catch((err) => {
    console.error('[ads-e2e] fatal:', err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
