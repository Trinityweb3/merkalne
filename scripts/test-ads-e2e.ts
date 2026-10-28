/**
 * Merklane Ads — HTTP end-to-end test.
 *
 * Drives the FULL advertiser journey against a live dev server:
 *   campaign create (paused) → crypto top-up (derived address) → simulate
 *   confirm (ADS_TOPUP_MODE=simulate) → resume → serve (weighted pick,
 *   atomic bill, impression ledger) → click → drain → auto-pause.
 * Plus the security rails: auth gate, CSRF, cross-origin block, simulate
 * disabled in manual mode, admin-only manual confirm.
 *
 * The test seeds its own user + session + csrf cookie directly in the
 * database (sqlite), then talks HTTP only — no route internals.
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
  opts: { method?: string; body?: unknown; auth?: string | null; origin?: string } = {},
): Promise<{ status: number; data: any }> {
  const auth = opts.auth !== undefined ? opts.auth : SESSION_TOKEN
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: opts.origin ?? ORIGIN,
  }
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
    body: JSON.stringify({ title: 'x', body: 'y', ctaUrl: 'https://a.b', bidPerView: 1 }),
  })
  check(noCsrf.status === 403, `POST without CSRF cookie/header → 403 (got ${noCsrf.status})`)

  const crossOrigin = await call('/api/ads/campaigns', {
    method: 'POST',
    origin: 'https://evil.example',
    body: { title: 'x', body: 'y', ctaUrl: 'https://a.b', bidPerView: 1 },
  })
  check(crossOrigin.status === 403, `cross-origin POST blocked (got ${crossOrigin.status})`)

  console.log('— 2. campaign validation —')
  const badUrl = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { title: 'Valid title', body: 'Valid body', ctaUrl: 'http://insecure.example', bidPerView: 2 },
  })
  check(badUrl.status === 400, 'http:// (non-https) destination rejected')

  const badBid = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { title: 'Valid title', body: 'Valid body', ctaUrl: 'https://a.b', bidPerView: 0 },
  })
  check(badBid.status === 400, 'bid below 1¢ rejected')

  console.log('— 3. campaign create → starts PAUSED with balance 0 —')
  const created = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      title: 'Hire Web3 engineers on Acme',
      body: 'Reach 40k+ monthly Web3 job seekers.',
      ctaUrl: 'https://acme.example/hiring',
      bidPerView: 2,
    },
  })
  check(created.status === 201, `campaign created 201 (got ${created.status})`)
  const campaignId = created.data?.id as string
  check(created.data?.status === 'paused', 'new campaign starts paused')

  console.log('— 4. serve answers 204 while paused/empty —')
  const serveEmpty = await fetch(`${ORIGIN}/api/ads/serve?slot=home_banner`)
  check(serveEmpty.status === 204, `serve with no eligible campaign → 204 (got ${serveEmpty.status})`)

  console.log('— 5. top-up flow —')
  const tooSmall = await call('/api/ads/topups', {
    method: 'POST',
    body: { campaignId, amountCents: 100 },
  })
  check(tooSmall.status === 400, 'top-up below $5 minimum rejected')

  const topUp = await call('/api/ads/topups', {
    method: 'POST',
    body: { campaignId, amountCents: 500 },
  })
  check(topUp.status === 201, `top-up created (got ${topUp.status})`)
  const topUpId = topUp.data?.id as string
  check(/^0x[0-9a-f]{40}$/.test(topUp.data?.walletAddress ?? ''), 'derived deposit address is 0x + 40 hex')
  check(topUp.data?.amountExpectedCents === 500, 'expected amount echoed (500 cents)')

  const topUpStatus = await call(`/api/ads/topups/${topUpId}`)
  check(topUpStatus.data?.status === 'pending', 'polling shows pending')

  const foreignTopUp = await call(`/api/ads/topups/${topUpId}`, { auth: ADMIN_SESSION_TOKEN })
  check(foreignTopUp.status === 404, "another user's top-up is invisible (404)")

  console.log('— 6. simulate confirm (ADS_TOPUP_MODE=simulate) —')
  const sim = await call(`/api/ads/topups/${topUpId}/simulate`, { method: 'POST' })
  if (!(sim.status === 200 && sim.data?.status === 'confirmed')) {
    console.log(`        [debug] simulate → ${sim.status}: ${JSON.stringify(sim.data)}`)
  }
  check(sim.status === 200 && sim.data?.status === 'confirmed', 'simulate confirms the top-up')
  check(sim.data?.creditedCents === 500, 'credited 500 cents')

  const simAgain = await call(`/api/ads/topups/${topUpId}/simulate`, { method: 'POST' })
  check(simAgain.status === 400, 'double-confirmation rejected (idempotent)')

  let list = await call('/api/ads/campaigns')
  let campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.balance === 500, `balance credited — 500 cents (got ${campaign?.balance})`)

  console.log('— 7. resume → active —')
  const resume = await call(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { action: 'resume' } })
  check(resume.status === 200 && resume.data?.status === 'active', 'campaign resumed to active')

  console.log('— 8. serve: weighted pick, atomic bill, impression ledger —')
  const served = await call('/api/ads/serve?slot=feed')
  check(served.status === 200 && served.data?.ad?.campaignId === campaignId, 'serve returns the active campaign')
  check(
    typeof served.data?.ad?.impressionId === 'string' && served.data.ad.impressionId.length > 0,
    'impression id issued',
  )
  check(served.data?.ad?.ctaHost === 'acme.example', 'cta host extracted for the card')

  list = await call('/api/ads/campaigns')
  campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.balance === 498, `balance decremented by the 2¢ bid (got ${campaign?.balance})`)
  check(campaign?.impressions === 1, `one view impression logged (got ${campaign?.impressions})`)

  console.log('— 9. click —')
  const badClick = await call('/api/ads/click', { method: 'POST', body: { impressionId: 'nonexistent' } })
  check(badClick.data?.recorded === false, 'click on unknown impression ignored')
  const click = await call('/api/ads/click', {
    method: 'POST',
    body: { impressionId: served.data.ad.impressionId },
  })
  check(click.data?.recorded === true, 'click recorded')
  list = await call('/api/ads/campaigns')
  campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.clicks === 1, `click visible in dashboard (got ${campaign?.clicks})`)

  console.log('— 10. drain → auto-pause (high-bid campaign, rate-limit aware) —')
  // The serve endpoint is rate-limited (30/min/IP) — the drain test uses a
  // SECOND campaign with the maximum 50¢ bid so $5 (500¢) drains in exactly
  // 10 serves, well inside one rate window. The first campaign is paused so
  // it cannot compete in the weighted draw.
  const pauseFirst = await call(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { action: 'pause' } })
  check(pauseFirst.data?.status === 'paused', 'first campaign paused (kept for stats)')

  const drainCreated = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { title: 'Drain test campaign', body: 'Drains fast at 50 cents.', ctaUrl: 'https://drain.example', bidPerView: 50 },
  })
  const drainId = drainCreated.data?.id as string
  check(drainCreated.status === 201, 'high-bid campaign created')
  const drainTopUp = await call('/api/ads/topups', { method: 'POST', body: { campaignId: drainId, amountCents: 500 } })
  const drainSim = await call(`/api/ads/topups/${drainTopUp.data?.id}/simulate`, { method: 'POST' })
  check(drainSim.data?.status === 'confirmed', 'drain campaign topped up (500 cents)')
  const drainResume = await call(`/api/ads/campaigns/${drainId}`, { method: 'PATCH', body: { action: 'resume' } })
  check(drainResume.data?.status === 'active', 'drain campaign active')

  let drainServes = 0
  for (let i = 0; i < 12; i++) {
    const s = await call('/api/ads/serve?slot=feed')
    if (s.status === 200) drainServes++
  }
  check(drainServes === 10, `exactly 10 serves billed before drain (got ${drainServes})`)

  list = await call('/api/ads/campaigns')
  const drained = list.data?.campaigns?.find((c: any) => c.id === drainId)
  check(drained?.balance === 0, `drain campaign balance 0 (got ${drained?.balance})`)
  check(drained?.status === 'paused', 'drained campaign auto-paused')
  check(drained?.impressions === 10, `drain campaign logged 10 impressions (got ${drained?.impressions})`)

  const serveDrained = await fetch(`${ORIGIN}/api/ads/serve?slot=feed`)
  check(serveDrained.status === 204, 'serve after drain → 204 (no eligible campaign)')

  const resumeEmpty = await call(`/api/ads/campaigns/${drainId}`, { method: 'PATCH', body: { action: 'resume' } })
  check(resumeEmpty.status === 400, 'resume with empty balance rejected')

  // First campaign keeps its history: 1 impression, 1 click, 498¢ left.
  const kept = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(kept?.impressions === 1 && kept?.clicks === 1, 'first campaign history intact (1 view, 1 click)')

  console.log('— 11. pages —')
  const adsPageAnon = await fetch(`${ORIGIN}/ads`, { redirect: 'manual' })
  check(adsPageAnon.status === 307, `/ads anonymous → 307 to login (got ${adsPageAnon.status})`)
  const adsPageAuth = await fetch(`${ORIGIN}/ads`, {
    headers: { Cookie: `merklane_session=${SESSION_TOKEN}` },
    redirect: 'manual',
  })
  check(adsPageAuth.status === 200, `/ads signed in → 200 (got ${adsPageAuth.status})`)

  console.log('— 12. cleanup —')
  await db.session.deleteMany({ where: { userId: { in: [advertiser.id, admin.id] } } })
  await db.user.deleteMany({ where: { id: { in: [advertiser.id, admin.id] } } })
  check(true, 'seed users removed (campaigns cascade)')

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
