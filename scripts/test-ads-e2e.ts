/**
 * Merklane Ads Phase 2 — HTTP end-to-end test (wizard lifecycle, uploads,
 * targeting, moderation through the Telegram admin bot).
 *
 * Drives the FULL advertiser + moderator journey against a live dev server:
 *   wallet deposit (ADS_TOPUP_MODE=simulate) → campaign created as DRAFT
 *   (free — no wallet money locked) → submit for review reserves the budget
 *   (RESERVE ledger row) → moderation via the REAL admin-bot webhook
 *   (🛡 Moderation Queue: list → preview → ✅ approve / ❌ reject with a
 *   reason) → ACTIVE → serve/click/billing (Phase 1 logic, unchanged) →
 *   banner upload (magic bytes, 1.5 MB cap) → keyword/hashtag/country
 *   targeting → content edit appends a creative revision and sends the
 *   campaign back to PENDING → re-approval → delete (REFUND).
 * Plus the security rails: auth gate, CSRF, cross-origin block, foreign
 * top-up invisibility, upload content sniffing, and the wallet ledger
 * invariant (available + reserved == Σcredit − Σcharge).
 *
 * The test seeds its own users + sessions + csrf cookie directly in the
 * database (sqlite), then talks HTTP only — plus white-box reads of the
 * reservation/ledger tables through the same Prisma client. The moderation
 * steps POST Telegram updates to /api/webhooks/telegram-admin (console
 * fallback transport — no bot token needed).
 *
 * Run via: bash scripts/run-ads-e2e.sh  (spawns the dev server on :3103)
 */
import { PrismaClient } from '@prisma/client'
import { createHash, randomBytes } from 'node:crypto'

const ORIGIN = (process.env.BASE_URL ?? 'http://localhost:3103').replace(/\/+$/, '')
const BOT = `${ORIGIN}/api/webhooks/telegram-admin`
const BOT_SECRET = 'test_admin_secret_0123456789ab'
const BOT_ADMIN_ID = 999000111
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

/** Multipart upload call for /api/ads/assets/upload (CSRF + session). */
async function upload(
  file: Blob,
): Promise<{ status: number; data: any }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${ORIGIN}/api/ads/assets/upload`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'X-CSRF-Token': CSRF,
      Cookie: `merklane_csrf=${CSRF}; merklane_session=${SESSION_TOKEN}`,
    },
    body: form,
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

/** Telegram admin-bot update posting (moderation drives from the webhook). */
let tgUpdateId = 1
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
async function bot(update: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(BOT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': BOT_SECRET },
    body: JSON.stringify(update),
  })
  // Unwrap the { ok, data } envelope the same way call() does, so callers
  // can read the payload (handled / denied / …) directly off `data`.
  let data: any = null
  try {
    const body = await res.json()
    data = body && typeof body === 'object' && 'data' in body ? body.data : body
  } catch {
    data = null
  }
  return { status: res.status, data }
}

/** Moderator helpers — the same buttons the 🛡 Moderation Queue renders. */
async function approveViaBot(campaignId: string): Promise<void> {
  const r = await bot(tgCallback(`modok:${campaignId}`))
  check(r.status === 200 && r.data?.handled === true, `bot approve ${campaignId.slice(0, 8)} → handled`)
}
async function rejectViaBot(campaignId: string, reason: string): Promise<void> {
  const open = await bot(tgCallback(`modno:${campaignId}`))
  check(open.status === 200, `bot reject flow opens for ${campaignId.slice(0, 8)}`)
  const r = await bot(tgMessage(reason))
  check(r.status === 200 && r.data?.handled === true, 'bot reject reason accepted')
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

/** Minimal real PNG (1×1) — valid magic bytes, tiny. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
/** Real WebP header (RIFF…WEBP) padded to a sniffable length. */
const TINY_WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'ascii'),
  Buffer.alloc(16, 0),
])
/** Script content renamed to .png — must be rejected by CONTENT sniffing. */
const EVIL_PNG = Buffer.from('<svg onload="fetch(\'https://evil.example/\')"><script>alert(1)</script></svg>', 'utf8')
/** Valid PNG header followed by junk — over the 1.5 MB size cap. */
const HUGE_PNG = Buffer.concat([TINY_PNG, Buffer.alloc(1_600_000, 0)])

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

  const uploadNoAuth = await fetch(`${ORIGIN}/api/ads/assets/upload`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
  })
  check(uploadNoAuth.status === 403 || uploadNoAuth.status === 401, `upload without CSRF/session rejected (got ${uploadNoAuth.status})`)

  console.log('— 2. banner upload: content sniffing, size cap, storage —')
  const evilUpload = await upload(new Blob([EVIL_PNG], { type: 'image/png' }))
  check(
    evilUpload.status === 415 && evilUpload.data?.code === 'bad_type',
    `renamed .png with SVG/script content → 415 bad_type (got ${evilUpload.status})`,
  )

  const hugeUpload = await upload(new Blob([HUGE_PNG], { type: 'image/png' }))
  check(
    hugeUpload.status === 413 && hugeUpload.data?.code === 'file_too_large',
    `banner over 1.5 MB → 413 file_too_large (got ${hugeUpload.status})`,
  )

  const pngUpload = await upload(new Blob([TINY_PNG], { type: 'image/png' }))
  check(pngUpload.status === 201 && typeof pngUpload.data?.url === 'string', `real PNG accepted (got ${pngUpload.status})`)
  const bannerUrl = pngUpload.data?.url as string
  check(/^\/uploads\/ads\/[a-f0-9-]+\.png$/.test(bannerUrl), `stored under /uploads/ads/ with a server-generated name (${bannerUrl})`)

  const webpUpload = await upload(new Blob([TINY_WEBP], { type: 'image/webp' }))
  check(webpUpload.status === 201 && /\.webp$/.test(webpUpload.data?.url ?? ''), 'real WebP accepted')

  const servedBanner = await fetch(`${ORIGIN}${bannerUrl}`)
  check(
    servedBanner.status === 200 && (servedBanner.headers.get('content-type') ?? '').startsWith('image/'),
    `uploaded banner served back (${servedBanner.status}, ${servedBanner.headers.get('content-type')})`,
  )
  const traversal = await fetch(`${ORIGIN}/uploads/..%2f..%2fpackage.json`)
  check(traversal.status !== 200 || (traversal.headers.get('content-type') ?? '').startsWith('image/'), 'path traversal through /uploads does not leak files')

  const externalBanner = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Valid name', format: 'banner', billingModel: 'cpm', bidCents: 200, budgetCents: 1000,
      targetUrl: 'https://acme.example', imageUrl: 'https://cdn.acme.example/banner.png', altText: 'Acme banner',
    },
  })
  check(
    externalBanner.status === 400,
    'external image URLs are rejected — banners must be uploaded (Phase 2)',
  )

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
    'banner campaign without an uploaded image → 400 creative_missing',
  )

  console.log('— 3. DRAFT creation is free; submission is the money gate —')
  const emptyWalletDraft = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Draft before funds', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000,
      targetUrl: 'https://acme.example', headline: 'Draft headline', body: 'Draft body copy',
    },
  })
  check(emptyWalletDraft.status === 201 && emptyWalletDraft.data?.status === 'draft', 'empty wallet can still create a DRAFT (no money locked)')
  const draftBeforeFundsId = emptyWalletDraft.data?.id as string
  const draftWallet = await wallet()
  check(draftWallet.available === 0 && draftWallet.reserved === 0, 'draft creation moved no wallet money')

  const submitNoFunds = await call(`/api/ads/campaigns/${draftBeforeFundsId}`, {
    method: 'PATCH',
    body: { action: 'submit' },
  })
  check(
    submitNoFunds.status === 400 && submitNoFunds.data?.code === 'insufficient_wallet',
    'submitting the draft with an empty wallet → 400 insufficient_wallet',
  )
  const stillDraft = await db.campaign.findUnique({ where: { id: draftBeforeFundsId } })
  check(stillDraft?.status === 'draft', 'failed submission leaves the campaign a draft')

  const servePending = await fetch(`${ORIGIN}/api/ads/serve?slot=feed`, { headers: { 'X-Forwarded-For': '10.20.0.0' } })
  check(servePending.status === 204, `serve with no eligible campaign → 204 (got ${servePending.status})`)

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

  // Second deposit so the campaigns' budgets are fully covered.
  const topUp2 = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 4500 } })
  const sim2 = await call(`/api/ads/topups/${topUp2.data?.id}/simulate`, { method: 'POST' })
  check(sim2.data?.status === 'confirmed', 'wallet topped up to $50 (4,500¢ more)')

  console.log('— 5. submit the draft → PENDING, budget reserved from the wallet —')
  const submitDraft = await call(`/api/ads/campaigns/${draftBeforeFundsId}`, {
    method: 'PATCH',
    body: { action: 'submit' },
  })
  check(submitDraft.status === 200 && submitDraft.data?.status === 'pending', 'draft submitted → PENDING')
  const campaignId = draftBeforeFundsId

  const submitWallet = await wallet()
  check(submitWallet.available === 40_000_000, `wallet available 40,000,000 µUSD (got ${submitWallet.available})`)
  check(submitWallet.reserved === 10_000_000, `wallet reserved 10,000,000 µUSD (got ${submitWallet.reserved})`)
  const reserveRow = submitWallet.raw?.ledger?.find((l: any) => l.campaignId === campaignId && l.type === 'reserve')
  check(reserveRow?.amountMicroUsd === -10_000_000, 'ledger shows the RESERVE row (−10,000,000 µUSD) at submit time')

  const doubleSubmit = await call(`/api/ads/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: { action: 'submit' },
  })
  check(doubleSubmit.status === 409 && doubleSubmit.data?.code === 'already_in_review', 'double submit → 409 already_in_review')

  const serveWhilePending = await call('/api/ads/serve?slot=feed', { ip: '10.20.0.30' })
  check(serveWhilePending.status === 204, 'PENDING campaign does not serve (no active campaign yet)')

  console.log('— 6. moderation: Telegram admin bot queue → approve → ACTIVE —')
  const queue = await bot(tgCallback('mod'))
  check(queue.status === 200, '🛡 Moderation Queue opens from the /start menu')
  const queueRow = await db.campaign.findMany({ where: { status: 'pending' } })
  check(queueRow.some((c) => c.id === campaignId), 'queue lists the pending campaign (DB)')

  const view = await bot(tgCallback(`modv:${campaignId}`))
  check(view.status === 200, 'queue item preview renders (ad card for the moderator)')

  await approveViaBot(campaignId)
  const approved = await db.campaign.findUnique({ where: { id: campaignId }, include: { creatives: true } })
  check(approved?.status === 'active', 'DB: campaign ACTIVE after the bot approve')
  check((approved?.creatives ?? []).every((c) => c.moderationStatus === 'approved'), 'DB: creative APPROVED')

  let list = await call('/api/ads/campaigns')
  let campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.status === 'active', 'dashboard shows the campaign active')
  check(campaign?.creative?.moderationStatus === 'approved', 'dashboard exposes the latest creative with its moderation status')

  const badApprove = await bot(tgCallback(`modok:${campaignId}`))
  check(badApprove.status === 200, 'approving an already-decided campaign is a no-op reply (no crash)')

  console.log('— 7. CPC serve: one bid held for 30 minutes (no charge yet) —')
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

  console.log('— 8. click: hold finalised, wallet charged —')
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

  console.log('— 9. hold expiry: unclicked CPC hold refunds the CAMPAIGN budget —')
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

  console.log('— 10. uploaded banner campaign (CPM) + moderation + daily cap —')
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
      imageUrl: bannerUrl,
      altText: 'Acme brand banner',
      submit: true,
    },
  })
  check(cpmCreated.status === 201 && cpmCreated.data?.status === 'pending', `CPM banner campaign created + submitted (got ${cpmCreated.status})`)
  const cpmId = cpmCreated.data?.id as string

  // Reject it first — the reason must reach the advertiser's dashboard.
  await rejectViaBot(cpmId, 'Banner creative is blurry — please upload a sharper image.')
  const rejectedRow = await db.campaign.findUnique({ where: { id: cpmId }, include: { creatives: true } })
  check(rejectedRow?.status === 'rejected', 'DB: campaign REJECTED after the bot reject')
  const rejectedCreative = rejectedRow?.creatives.find((c) => c.version === 1)
  check(
    rejectedCreative?.moderationStatus === 'rejected' && (rejectedCreative?.moderationNote ?? '').includes('blurry'),
    'DB: rejection reason stored on the creative',
  )
  list = await call('/api/ads/campaigns')
  const rejectedDash = list.data?.campaigns?.find((c: any) => c.id === cpmId)
  check(rejectedDash?.status === 'rejected', 'dashboard shows the REJECTED campaign (drafts/rejections stay visible)')
  check((rejectedDash?.creative?.moderationNote ?? '').includes('blurry'), 'dashboard shows the rejection reason verbatim')

  // Rejected campaigns keep their committed budget; edit + resubmit.
  const rejectedWallet = await wallet()
  // 19.5M = the CPC campaign's 10M minus its 0.5M click charge (a charge
  // leaves the wallet's reserved bucket) + the banner's 10M committed here.
  check(rejectedWallet.reserved === 19_500_000, `rejected campaign keeps its budget reserved (got ${rejectedWallet.reserved})`)

  const resubmit = await call(`/api/ads/campaigns/${cpmId}`, {
    method: 'PATCH',
    body: { action: 'submit' },
  })
  check(resubmit.status === 200 && resubmit.data?.status === 'pending', 'rejected campaign resubmitted without extra edits')
  await approveViaBot(cpmId)
  const cpmActive = await db.campaign.findUnique({ where: { id: cpmId } })
  check(cpmActive?.status === 'active', 'DB: banner campaign ACTIVE after re-approval')
  // Resubmission only reserves the shortfall (already fully committed).
  const resubmitWallet = await wallet()
  check(resubmitWallet.reserved === 19_500_000, `resubmit did not double-lock money (reserved ${resubmitWallet.reserved})`)

  // Pause the CPC campaign so the CPM pool is the only competitor.
  const pauseFirst = await call(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { action: 'pause' } })
  check(pauseFirst.data?.status === 'paused', 'CPC campaign paused for a deterministic CPM run')

  let cpmServed = 0
  let sawBanner = false
  for (let i = 0; i < 21; i++) {
    const s = await call('/api/ads/serve?slot=feed', { ip: `10.21.0.${i + 1}` })
    if (s.status === 200) {
      cpmServed++
      if (s.data?.ad?.format === 'banner' && String(s.data?.ad?.imageUrl ?? '').startsWith('/uploads/ads/')) sawBanner = true
    }
  }
  check(cpmServed === 20, `exactly 20 views charged before the daily cap (got ${cpmServed})`)
  check(sawBanner, 'served ad carries the uploaded banner creative (local /uploads/ads/ path)')
  const serveBanner = await call('/api/ads/serve?slot=feed&country=DE', { ip: '10.21.9.9' })
  check(
    serveBanner.status === 204 || (serveBanner.data?.ad?.altText ?? '') === 'Acme brand banner',
    'banner alt text carried through the serve API',
  )

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
  // reserved = c1 (10M) + c2 (10M) − the 20 CPM charges (1M)
  check(cpmWallet.reserved === 18_500_000, `wallet reserved after the CPM charges (got ${cpmWallet.reserved})`)
  inv = await ledgerInvariant(advertiser.id)
  check(inv.ok, `ledger invariant after the CPM run (${inv.detail})`)

  console.log('— 11. advanced targeting: keywords (exact/phrase), hashtags, countries —')
  const targeted = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Solidity keyword campaign',
      format: 'text',
      billingModel: 'cpc',
      bidCents: 25,
      budgetCents: 500,
      targetUrl: 'https://solidity.example',
      headline: 'Learn Solidity fast',
      body: 'Interactive Solidity course for junior devs.',
      targetKeywords: ['Solidity 101'],
      keywordMatch: 'exact',
      targetHashtags: ['web3'],
      countryMode: 'include',
      targetCountries: ['DE', 'US'],
      submit: true,
    },
  })
  check(targeted.status === 201 && targeted.data?.status === 'pending', 'keyword/hashtag/country campaign created + submitted')
  const targetId = targeted.data?.id as string
  await approveViaBot(targetId)

  const tRow = await db.campaign.findUnique({ where: { id: targetId } })
  check(tRow?.targetKeywords === 'solidity 101' && tRow?.keywordMatch === 'exact', 'DB: keywords stored lowercased + exact mode')
  check(tRow?.countryMode === 'include' && tRow?.targetCountries === 'DE,US', 'DB: country mode + ISO codes stored')
  check(tRow?.targetHashtags === 'web3', 'DB: hashtags stored without #')

  // Pause the banner campaign so targeting checks are deterministic.
  await call(`/api/ads/campaigns/${cpmId}`, { method: 'PATCH', body: { action: 'pause' } })

  const noKeywordCtx = await call('/api/ads/serve?slot=article_bottom&country=DE', { ip: '10.22.0.1' })
  check(noKeywordCtx.status === 204, 'keyword-targeted campaign skips pages without keyword context')

  const wrongKeyword = await call('/api/ads/serve?slot=article_bottom&keywords=solidity&country=DE', { ip: '10.22.0.2' })
  check(wrongKeyword.status === 204, 'exact keyword mismatch ("solidity" ≠ "solidity 101") → no serve')

  const rightKeywordWrongCountry = await call('/api/ads/serve?slot=article_bottom&keywords=Solidity%20101&country=FR', { ip: '10.22.0.3' })
  check(rightKeywordWrongCountry.status === 204, 'keyword match but country outside include list → no serve')

  const rightKeywordRightCountry = await call('/api/ads/serve?slot=article_bottom&keywords=Solidity%20101&hashtags=web3&country=DE', { ip: '10.22.0.4' })
  check(
    rightKeywordRightCountry.status === 200 && rightKeywordRightCountry.data?.ad?.campaignId === targetId,
    'exact keyword + included country → campaign serves',
  )
  const holdToExpire = rightKeywordRightCountry.data?.ad?.reservationId as string
  if (holdToExpire) await db.budgetReservation.update({ where: { id: holdToExpire }, data: { expiresAt: new Date(Date.now() - 1_000) } })

  const phraseServe = await call('/api/ads/serve?slot=article_bottom&keywords=best%20course,Solidity%20101&hashtags=web3&country=US', { ip: '10.22.0.5' })
  check(phraseServe.status === 200, 'phrase-style context (superset keywords + hashtag + country) also matches')
  const hold2 = phraseServe.data?.ad?.reservationId as string
  if (hold2) await db.budgetReservation.update({ where: { id: hold2 }, data: { expiresAt: new Date(Date.now() - 1_000) } })

  const cfCountry = await call('/api/ads/serve?slot=article_bottom&keywords=Solidity%20101', { ip: '10.22.0.6' })
  check(cfCountry.status === 204, 'unknown visitor country (no CF header, no param) → restricted campaign skipped')

  console.log('— 12. editing an APPROVED campaign: new revision, back to PENDING —')
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
  check(edit.data?.status === 'pending' && edit.data?.version === 2, 'edit appends creative v2 and sends the campaign back to PENDING')

  list = await call('/api/ads/campaigns')
  campaign = list.data?.campaigns?.find((c: any) => c.id === campaignId)
  check(campaign?.status === 'pending', 'dashboard shows the campaign in review again')
  check(campaign?.creative?.version === 2, 'dashboard serves creative v2 (latest revision)')
  check(campaign?.creative?.title?.includes('v2'), 'v2 headline stored')
  const v2Count = await db.creative.count({ where: { campaignId } })
  check(v2Count === 2, 'creative history is append-only (2 rows)')

  const wrongLocale = await call('/api/ads/serve?slot=feed&locale=en', { ip: '10.26.0.1' })
  check(wrongLocale.status === 204, 'pending campaign does not serve even in a targeted locale')

  await approveViaBot(campaignId)
  const reapproved = await db.campaign.findUnique({ where: { id: campaignId }, include: { creatives: true } })
  check(reapproved?.status === 'active' && reapproved.creatives.every((c) => c.moderationStatus === 'approved'), 're-approval → ACTIVE with both revisions approved')

  const rightLocale = await call('/api/ads/serve?slot=feed&locale=ru', { ip: '10.26.0.2' })
  check(
    rightLocale.status === 200 && rightLocale.data?.ad?.campaignId === campaignId && rightLocale.data?.ad?.title?.includes('v2'),
    'locale match → campaign serves with the v2 creative',
  )
  // The Russian serve holds a bid — expire-check it in the next section.
  const ruHold = rightLocale.data?.ad?.reservationId as string
  if (ruHold) await db.budgetReservation.update({ where: { id: ruHold }, data: { expiresAt: new Date(Date.now() - 1_000) } })

  console.log('— 13. add funds (RESERVE) + delete (REFUND) + draft deletion —')
  // The create route's 6/min anti-abuse limit (by design) also counts the
  // three intentional-invalid banner attempts from section 2, so the bucket
  // already holds 6 tokens here — the two creates below would 429. Wait for
  // the oldest token to age out of the 60 s window (a real client sees the
  // same 429 and retries after a minute).
  await new Promise((r) => setTimeout(r, 61_000))
  // Draft deletion: no committed budget → no refund row, row just disappears.
  const draftForDelete = await call('/api/ads/campaigns', {
    method: 'POST',
    body: {
      name: 'Doomed draft', format: 'text', billingModel: 'cpc', bidCents: 50, budgetCents: 1000,
      targetUrl: 'https://doomed.example', headline: 'Never submitted', body: 'This draft will be deleted.',
    },
  })
  const doomedId = draftForDelete.data?.id as string
  check(draftForDelete.data?.status === 'draft', `second draft created for the delete test (got ${draftForDelete.status})`)
  const fundDraft = await call(`/api/ads/campaigns/${doomedId}`, {
    method: 'PATCH',
    body: { action: 'fund', amountCents: 200 },
  })
  check(fundDraft.status === 400 && fundDraft.data?.code === 'draft_not_fundable', 'funding a draft is rejected (submit first)')

  const preDraftDelete = await wallet()
  const deleteDraft = await call(`/api/ads/campaigns/${doomedId}`, { method: 'PATCH', body: { action: 'delete' } })
  check(deleteDraft.status === 200 && deleteDraft.data?.status === 'deleted', 'draft deleted (soft delete from DRAFT state)')
  const postDraftDelete = await wallet()
  check(postDraftDelete.available === preDraftDelete.available, 'draft deletion moved no wallet money')
  const noDraftRefund = postDraftDelete.raw?.ledger?.find((l: any) => l.eventId === `refund:${doomedId}`)
  check(noDraftRefund === undefined, 'no refund row for a moneyless draft')

  // Drain: 20 clicks at $0.10 exhaust a $2.00 budget.
  const drainTopUp = await call('/api/ads/topups', { method: 'POST', body: { amountCents: 500 } })
  const drainSim = await call(`/api/ads/topups/${drainTopUp.data?.id}/simulate`, { method: 'POST' })
  check(drainSim.data?.status === 'confirmed', 'wallet recharged ($5)')

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
      submit: true,
    },
  })
  check(drainCreated.status === 201, `drain campaign created + submitted (got ${drainCreated.status})`)
  const drainId = drainCreated.data?.id as string
  await approveViaBot(drainId)
  // Pause the other active CPC campaigns so the drain run is deterministic —
  // the §11 targeted campaign (still ACTIVE) and the §12-reapproved
  // campaign1 would otherwise share the pool (bids $0.25/$0.50 vs the drain's
  // $0.10) and the drain campaign would never exhaust its $2 in 20 billed
  // clicks. Same isolation pattern section 10 used for the CPM run.
  await call(`/api/ads/campaigns/${targetId}`, { method: 'PATCH', body: { action: 'pause' } })
  await call(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { action: 'pause' } })

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

  // A drained campaign stays ACTIVE — the auction's out-of-budget filter is
  // what stops it serving (there is no auto-pause). Pause it explicitly so
  // the resume guard below can be exercised on a paused, empty campaign.
  const pauseDrained = await call(`/api/ads/campaigns/${drainId}`, { method: 'PATCH', body: { action: 'pause' } })
  check(pauseDrained.data?.status === 'paused', 'drained campaign paused before the resume check')

  const resumeEmpty = await call(`/api/ads/campaigns/${drainId}`, { method: 'PATCH', body: { action: 'resume' } })
  check(
    resumeEmpty.status === 400 && resumeEmpty.data?.code === 'out_of_budget',
    'resume with an empty budget → 400 out_of_budget',
  )

  const tinyFund = await call(`/api/ads/campaigns/${drainId}`, {
    method: 'PATCH',
    body: { action: 'fund', amountCents: 50 },
  })
  check(tinyFund.status === 400 && tinyFund.data?.code === 'amount_too_small', 'fund below $1 minimum rejected')

  const overFund = await call(`/api/ads/campaigns/${drainId}`, {
    method: 'PATCH',
    body: { action: 'fund', amountCents: 50000 },
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

  console.log('— 14. /mod command + queue refresh —')
  const modCommand = await bot(tgMessage('/mod'))
  check(modCommand.status === 200 && modCommand.data?.handled === true, '/mod command opens the moderation queue')
  const nonAdmin = await bot({ ...tgCallback('mod'), callback_query: { ...tgCallback('mod').callback_query, from: { id: 111222333 } } })
  check(nonAdmin.status === 200 && nonAdmin.data?.denied === true, 'non-admin is politely denied (still 200)')

  console.log('— 15. pages —')
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

  console.log('— 16. cleanup —')
  await db.session.deleteMany({ where: { userId: { in: [advertiser.id, admin.id] } } })
  await db.user.deleteMany({ where: { id: { in: [advertiser.id, admin.id] } } })
  await db.telegramAdminState.deleteMany({})
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
