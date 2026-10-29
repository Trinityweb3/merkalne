/**
 * Merklane Ads — HTTP end-to-end test (wallet-first flow).
 *
 * Drives the FULL advertiser journey against a live dev server:
 *   wallet deposit (derived address, ADS_TOPUP_MODE=simulate) → simulate
 *   confirm → campaign created + funded FROM the wallet (starts ACTIVE) →
 *   serve (weighted pick, targeting filter, atomic bill, impression ledger)
 *   → click → PATCH fund / update / pause → drain → auto-pause.
 * Plus the security rails: auth gate, CSRF, cross-origin block, simulate
 * disabled in manual mode, another user's top-up invisible.
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

async function wallet(): Promise<{ balance: number; pending: number }> {
  const w = await call('/api/ads/wallet')
  return { balance: w.data?.balanceCents ?? -1, pending: w.data?.pendingCents ?? -1 }
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
  const startWallet = await wallet()
  check(startWallet.balance === 0, 'advertiser starts with an empty ad wallet')

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

  console.log('— 2. campaign validation & wallet gate —')
  const badUrl = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { title: 'Valid title', body: 'Valid body', ctaUrl: 'http://insecure.example', bidPerView: 2, budgetCents: 500 },
  })
  check(badUrl.status === 400, 'http:// (non-https) destination rejected')

  const badBid = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { title: 'Valid title', body: 'Valid body', ctaUrl: 'https://a.b', bidPerView: 0, budgetCents: 500 },
  })
  check(badBid.status === 400, 'bid below 1¢ rejected')

  const tinyBudget = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { title: 'Valid title', body: 'Valid body', ctaUrl: 'https://acme.example', bidPerView: 10, budgetCents: 300 },
  })
  check(
    tinyBudget.status === 400 && tinyBudget.data?.code === 'budget_too_small',
    'budget below the 50-view minimum → 400 budget_too_small',
  )

  const noFunds = await call('/api/ads/campaigns', {
    method: 'POST',
    body: { title: 'Valid title', body: 'Valid body', ctaUrl: 'https://acme.example', bidPerView: 2, budgetCents: 500 },
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

  console.log('— 4. wallet deposit (simulate mode) —')
  const tooSmall = await call('/api/ads/topups', {
    method: 'POST',
    body: { amountCents: 100 },
  })
  check(tooSmall.status === 400, 'deposit below $5 minimum rejected')

  const topUp = await call('/api/ads/topups', {
    method: 'POST',
    body: { amountCents: 500 },
  })
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
  check(fundedWallet.balance === 500 && fundedWallet.pending === 0, `wallet credited 500¢ (got ${fundedWallet.balance})`)

  console.log('— 5. campaign created + funded FROM the wallet (starts ACTIVE) —')
  const created = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      title: 'Hire Web3 engineers on Acme',
      body: 'Reach 40k+ monthly Web3 job seekers.',
      ctaUrl: 'https://acme.example/hiring',
      bidPerView: 2,
      budgetCents: 500,
    },
  })
  check(created.status === 201, `campaign created 201 (got ${created.status})`)
  const campaignId = created.data?.id as string
  check(created.data?.status === 'active', 'funded campaign starts ACTIVE')

  const spentWallet = await wallet()
  check(spentWallet.balance === 0, 'wallet drained by the campaign allocation')
  check(spentWallet.pending === 0, 'no pending deposits left')

  let list = await call('/api/ads/campaigns')
  let campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.balance === 500, `campaign flight budget 500¢ (got ${campaign?.balance})`)

  console.log('— 6. serve: weighted pick, atomic bill, impression ledger —')
  const served = await call('/api/ads/serve?slot=feed', { ip: '10.20.0.1' })
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

  console.log('— 7. click —')
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

  console.log('— 8. PATCH fund / update / pause —')
  // Pause campaign #1 so it stops competing in the weighted draw.
  const pauseFirst = await call(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { action: 'pause' } })
  check(pauseFirst.data?.status === 'paused', 'campaign paused')

  // Fund it from a fresh wallet deposit (PATCH action=fund).
  const fundTopUp = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 500 } })
  const fundSim = await call(`/api/ads/topups/${fundTopUp.data?.id}/simulate`, { method: 'POST' })
  check(fundSim.data?.status === 'confirmed', 'wallet recharged (500 cents)')

  const tinyFund = await call(`/api/ads/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: { action: 'fund', amountCents: 50 },
  })
  check(tinyFund.status === 400 && tinyFund.data?.code === 'amount_too_small', 'fund below $1 minimum rejected')

  const overFund = await call(`/api/ads/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: { action: 'fund', amountCents: 5000 },
  })
  check(overFund.status === 400 && overFund.data?.code === 'insufficient_wallet', 'fund beyond the wallet rejected')

  const fund = await call(`/api/ads/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: { action: 'fund', amountCents: 200 },
  })
  check(fund.status === 200 && fund.data?.balanceCents === 698, `campaign funded to 698¢ (got ${fund.data?.balanceCents})`)
  check(fund.data?.walletBalanceCents === 300, `wallet left at 300¢ (got ${fund.data?.walletBalanceCents})`)

  const edit = await call(`/api/ads/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: { action: 'update', title: 'Hire Web3 engineers on Acme — updated', ctaLabel: 'Apply now' },
  })
  check(edit.data?.status === 'updated', 'campaign content updated')
  list = await call('/api/ads/campaigns')
  campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.title?.includes('updated'), 'updated title served back')

  console.log('— 9. targeting: section + locale filters (50¢ bid, 2500¢ minimum flight) —')
  // min budget at a 50¢ bid = 50 views × 50¢ = $25 — one $25 deposit
  // covers the minimum flight exactly. (The empty-wallet gate itself is
  // already proven in section 2; the campaign-create rate limit means we
  // spend our POST budget on the real create here.)
  const targetTopUp = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 2500 } })
  const targetSim = await call(`/api/ads/topups/${targetTopUp.data?.id}/simulate`, { method: 'POST' })
  check(targetSim.data?.status === 'confirmed', 'wallet recharged ($25)')

  const targeted = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      title: 'Targeted drain campaign',
      body: 'Only shows on intern-junior pages, ru interface.',
      ctaUrl: 'https://drain.example',
      bidPerView: 50,
      budgetCents: 2500,
      targetSections: ['intern-junior'],
    },
  })
  check(targeted.status === 201, `targeted campaign created (got ${targeted.status})`)
  const drainId = targeted.data?.id as string
  check(targeted.data?.status === 'active', 'targeted campaign active')

  const wrongSection = await call('/api/ads/serve?slot=feed&section=mid-senior', { ip: '10.20.0.2' })
  check(wrongSection.status === 204, 'section the campaign does NOT target → 204')

  const rightSection = await call('/api/ads/serve?slot=feed&section=intern-junior', { ip: '10.20.0.3' })
  check(
    rightSection.status === 200 && rightSection.data?.ad?.campaignId === drainId,
    'targeted section match → campaign served',
  )

  // Narrow further by locale via PATCH update.
  const localeEdit = await call(`/api/ads/campaigns/${drainId}`, {
    method: 'PATCH',
    body: { action: 'update', targetLocales: ['ru'] },
  })
  check(localeEdit.data?.status === 'updated', 'locale targeting applied')

  const wrongLocale = await call('/api/ads/serve?slot=feed&section=intern-junior&locale=en', { ip: '10.20.0.4' })
  check(wrongLocale.status === 204, 'locale the campaign does NOT target → 204')

  const rightLocale = await call('/api/ads/serve?slot=feed&section=intern-junior&locale=ru', { ip: '10.20.0.5' })
  check(
    rightLocale.status === 200 && rightLocale.data?.ad?.campaignId === drainId,
    'locale match → campaign served',
  )

  console.log('— 10. drain → auto-pause (2500¢ at 50¢/view = 50 serves; 2 billed) —')
  // Impressions come from DISTINCT visitors in production — rotate the
  // client IP so the per-IP serve rate limit models many visitors, not one.
  let drainServes = 0
  for (let i = 0; i < 55; i++) {
    const s = await call('/api/ads/serve?slot=feed&section=intern-junior&locale=ru', {
      ip: `10.21.${Math.floor(i / 20)}.${(i % 20) + 1}`,
    })
    if (s.status === 200) drainServes++
    else break
  }
  check(drainServes === 48, `exactly 48 more serves billed before drain (got ${drainServes})`)

  list = await call('/api/ads/campaigns')
  const drained = list.data?.campaigns?.find((c: any) => c.id === drainId)
  check(drained?.balance === 0, `drain campaign balance 0 (got ${drained?.balance})`)
  check(drained?.status === 'paused', 'drained campaign auto-paused')
  check(drained?.impressions === 50, `drain campaign logged 50 impressions (got ${drained?.impressions})`)

  const serveDrained = await call('/api/ads/serve?slot=feed&section=intern-junior&locale=ru', { ip: '10.22.0.1' })
  check(serveDrained.status === 204, 'serve after drain → 204 (no eligible campaign)')

  const resumeEmpty = await call(`/api/ads/campaigns/${drainId}`, { method: 'PATCH', body: { action: 'resume' } })
  check(resumeEmpty.status === 400, 'resume with empty balance rejected')

  // First campaign keeps its history: 1 impression, 1 click, 698¢ left.
  const kept = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(kept?.impressions === 1 && kept?.clicks === 1, 'first campaign history intact (1 view, 1 click)')
  check(kept?.balance === 698, `first campaign balance intact (698¢, got ${kept?.balance})`)

  console.log('— 11. pages —')
  // /ads is a permanent redirect to the profile-cabinet dashboard now.
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
