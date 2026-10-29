/**
 * BlockBee API client (https://blockbee.io — formerly CryptAPI).
 *
 * Replaces the old self-custodial "derive our own deposit addresses" top-up
 * logic (gas costs, key-management risk, AML exposure) with an external
 * processor that provides:
 *   • hosted payment addresses — GET /{ticker}/create/
 *   • built-in AML screening
 *   • fees in the 0.25–1% range
 *   • an automated payout chain for referral withdrawals
 *
 * Endpoints used (all documented at https://docs.blockbee.io):
 *   GET  /{ticker}/create/                  — issue a payment address
 *   GET  /convert/                          — USD → coin conversion
 *   GET  /{ticker}/payout/request/create/   — create a payout REQUEST
 *   POST /payout/create/                    — bundle request(s) into a payout
 *   POST /payout/process/                   — broadcast the payout
 *   POST /payout/status/                    — check a payout's status
 *   GET  /pubkey/                           — RSA public key for webhooks
 *
 * Webhook security (see /api/webhooks/blockbee) — TWO independent schemes:
 *   1. RSA-SHA256 (BlockBee production): the `x-ca-signature` header carries
 *      a base64 signature over the full URL (GET) or raw body (POST), made
 *      with BlockBee's private key; we verify with the pubkey from /pubkey/.
 *   2. HMAC-SHA256 (BLOCKBEE_IPN_SECRET): a `token` query parameter carries
 *      a hex HMAC of the remaining query string keyed with the shared
 *      secret. Constant-time compared.
 *   A webhook is accepted when EITHER scheme verifies; both inputs present
 *   but both wrong → rejected. On top of that, every payment intention
 *   embeds an unguessable per-row `nonce` in its callback URL that must be
 *   echoed back — binding each webhook to exactly one DB row.
 *
 * Coin policy (client requirement): stablecoins (USDT/USDC) and major coins
 * on cheap networks only — Solana, Polygon, BSC, Arbitrum. TRON is explicitly
 * banned (high fraud rate): `isTronTicker()` is enforced on top of whatever
 * BLOCKBEE_COINS allowlist is configured, so TRON can never be re-enabled by
 * misconfiguration.
 */
import 'server-only'
import crypto from 'node:crypto'
import { env } from '@/lib/env'

const DEFAULT_TIMEOUT_MS = 15_000

/** Allowlist default: stablecoins + major coins on cheap networks (no TRON, no Ethereum-mainnet gas). */
export const BLOCKBEE_DEFAULT_COINS = [
  'sol', // Solana (SOL)
  'polygon_usdt', 'polygon_usdc', // USDT/USDC on Polygon
  'bep20_usdt', 'bep20_usdc', // USDT/USDC on BNB Smart Chain (BSC)
  'arbitrum_usdt', 'arbitrum_usdc', // USDT/USDC on Arbitrum One
  'bnb', // BNB (BSC native)
  'pol', // POL (Polygon native)
] as const

/** TRON tickers are banned by policy (high fraud rate) — checked in addition to any configured allowlist. */
export function isTronTicker(ticker: string): boolean {
  const t = ticker.trim().toLowerCase()
  return t === 'trx' || t.startsWith('trc20')
}

/**
 * The coin allowlist offered for top-ups and payouts. TRON entries are
 * filtered out even when explicitly configured — the ban is not overridable.
 */
export function allowedCoins(): string[] {
  const raw = (env.BLOCKBEE_COINS ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
  const source = raw.length > 0 ? raw : [...BLOCKBEE_DEFAULT_COINS]
  return [...new Set(source)].filter((c) => !isTronTicker(c))
}

/** Is the BlockBee processor usable right now (API key configured)? */
export function blockbeeConfigured(): boolean {
  return Boolean(env.BLOCKBEE_API_KEY)
}

/** Minimum referral withdrawal in US cents (env-tunable, default $20). */
export function minWithdrawCents(): number {
  return env.BLOCKBEE_MIN_PAYOUT_CENTS
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export class BlockBeeApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public endpoint: string,
  ) {
    super(message)
    this.name = 'BlockBeeApiError'
  }
}

/**
 * Resolve the API base. BLOCKBEE_API_BASE is read straight from process.env
 * (not part of the validated schema) so test harnesses can point the client
 * at a mock server without polluting the production env contract; unset it
 * and the public https://api.blockbee.io is used.
 */
export function blockbeeApiBase(): string {
  return (process.env.BLOCKBEE_API_BASE ?? 'https://api.blockbee.io').replace(/\/+$/, '')
}

async function bbGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${blockbeeApiBase()}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let res: Response
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'User-Agent': 'merklane-blockbee-client/1.0' },
      cache: 'no-store',
    })
  } catch (err) {
    throw new BlockBeeApiError(
      `BlockBee request failed (${err instanceof Error ? err.message : 'network error'})`,
      0,
      path,
    )
  }
  const body = (await res.json().catch(() => null)) as (T & { status?: string }) | null
  if (!res.ok || !body || (body.status && body.status !== 'success')) {
    const message =
      (body as Record<string, unknown> | null)?.error ?? `HTTP ${res.status} from ${path}`
    throw new BlockBeeApiError(String(message), res.status, path)
  }
  return body
}

async function bbFormPost<T>(path: string, form: Record<string, string>): Promise<T> {
  const url = new URL(`${blockbeeApiBase()}${path}`)
  url.searchParams.set('apikey', env.BLOCKBEE_API_KEY ?? '')
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      body: new URLSearchParams(form),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'merklane-blockbee-client/1.0',
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (err) {
    throw new BlockBeeApiError(
      `BlockBee request failed (${err instanceof Error ? err.message : 'network error'})`,
      0,
      path,
    )
  }
  const body = (await res.json().catch(() => null)) as (T & { status?: string }) | null
  if (!res.ok || !body || (body.status && body.status !== 'success')) {
    const message =
      (body as Record<string, unknown> | null)?.error ?? `HTTP ${res.status} from ${path}`
    throw new BlockBeeApiError(String(message), res.status, path)
  }
  return body
}

// ---------------------------------------------------------------------------
// Payments: create an intention (deposit address)
// ---------------------------------------------------------------------------

export interface BlockBeeIntention {
  /** BlockBee-hosted address the customer pays to (address_in) */
  addressIn: string
  /** Processor minimum for this coin (in coin units) */
  minimumCoin: number | null
  /** The callback URL BlockBee registered for this address */
  callbackUrl: string
}

/**
 * Issue a unique payment address for one top-up intention.
 *
 * The `callbackUrl` MUST be unique per intention (BlockBee reuses the same
 * address_in for the same callback URL) — the caller embeds `order_id` and an
 * unguessable `nonce` as query parameters, both echoed back in every IPN.
 * `convert=1` asks BlockBee to include USD conversions in the IPN payload.
 */
export async function createPaymentIntention(opts: {
  coin: string
  callbackUrl: string
}): Promise<BlockBeeIntention> {
  if (isTronTicker(opts.coin)) {
    throw new BlockBeeApiError('TRON payments are disabled by policy', 400, 'create')
  }
  const res = await bbGet<{ address_in: string; callback_url?: string; minimum_transaction_coin?: number }>(
    `/${encodeURIComponent(opts.coin)}/create/`,
    {
      apikey: env.BLOCKBEE_API_KEY ?? '',
      callback: opts.callbackUrl,
      convert: '1',
    },
  )
  if (!res.address_in) {
    throw new BlockBeeApiError('BlockBee returned no payment address', 502, 'create')
  }
  return {
    addressIn: res.address_in,
    minimumCoin:
      typeof res.minimum_transaction_coin === 'number' ? res.minimum_transaction_coin : null,
    callbackUrl: res.callback_url ?? opts.callbackUrl,
  }
}

// ---------------------------------------------------------------------------
// Conversion (USD → coin) for payouts
// ---------------------------------------------------------------------------

export async function convertUsdToCoin(
  coin: string,
  usdValue: number,
): Promise<{ coinAmount: string; exchangeRate: string }> {
  const res = await bbGet<{ value_coin: string; exchange_rate: string }>('/convert/', {
    apikey: env.BLOCKBEE_API_KEY ?? '',
    value: String(usdValue),
    from: 'usd',
    to: coin,
  })
  return { coinAmount: res.value_coin, exchangeRate: res.exchange_rate }
}

// ---------------------------------------------------------------------------
// Payouts (referral withdrawals)
// ---------------------------------------------------------------------------

export interface PayoutInfo {
  id: string
  status: string // created | processing | done | rejected | expired | error
  displayStatus?: string
  totalRequested?: string
  totalWithFee?: string
  error?: string | null
  txid?: string
  coin?: string
}

/** Step 1 — create a payout REQUEST (nothing is sent yet). Returns request_id. */
export async function createPayoutRequest(coin: string, address: string, coinAmount: string): Promise<string> {
  if (isTronTicker(coin)) {
    throw new BlockBeeApiError('TRON payouts are disabled by policy', 400, 'payout/request/create')
  }
  const res = await bbGet<{ request_id: string }>(
    `/${encodeURIComponent(coin)}/payout/request/create/`,
    {
      apikey: env.BLOCKBEE_API_KEY ?? '',
      address,
      value: coinAmount,
    },
  )
  return res.request_id
}

/** Step 2 — bundle payout request(s) into a payout. Returns the payout id. */
export async function createPayoutFromRequests(requestIds: string[]): Promise<PayoutInfo> {
  const res = await bbFormPost<{ payout_info: { id: string; status: string; display_status?: string } }>(
    '/payout/create/',
    { request_ids: requestIds.join(',') },
  )
  return {
    id: res.payout_info.id,
    status: res.payout_info.status,
    displayStatus: res.payout_info.display_status,
  }
}

/**
 * Step 3 — broadcast the payout. Safe to retry: BlockBee verifies previous
 * attempts on-chain before re-sending, so a retry can never double-pay.
 */
export async function processPayout(payoutId: string): Promise<PayoutInfo> {
  const res = await bbFormPost<{
    queued?: boolean
    payout_info: { id: string; status: string; display_status?: string; error?: string | null }
  }>('/payout/process/', { payout_id: payoutId })
  return {
    id: res.payout_info.id,
    status: res.payout_info.status,
    displayStatus: res.payout_info.display_status,
    error: res.payout_info.error ?? null,
  }
}

/** Check a payout's status (created | processing | done | rejected | expired | error). */
export async function getPayoutStatus(payoutId: string): Promise<PayoutInfo> {
  const res = await bbFormPost<{
    payout_info: {
      id: string
      status: string
      display_status?: string
      txid?: string
      error?: string | null
      total_requested?: string
      total_with_fee?: string
      coin?: string
    }
  }>('/payout/status/', { payout_id: payoutId })
  return {
    id: res.payout_info.id,
    status: res.payout_info.status,
    displayStatus: res.payout_info.display_status,
    txid: res.payout_info.txid,
    error: res.payout_info.error ?? null,
    totalRequested: res.payout_info.total_requested,
    totalWithFee: res.payout_info.total_with_fee,
    coin: res.payout_info.coin,
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

let pubkeyCache: { pem: string; fetchedAt: number } | null = null
const PUBKEY_TTL_MS = 60 * 60 * 1000 // re-fetch hourly (key rotation headroom)

/** Fetch (and cache) BlockBee's RSA public key used for x-ca-signature. */
export async function fetchBlockBeePublicKey(force = false): Promise<string | null> {
  if (!force && pubkeyCache && Date.now() - pubkeyCache.fetchedAt < PUBKEY_TTL_MS) {
    return pubkeyCache.pem
  }
  try {
    const res = await fetch(`${blockbeeApiBase()}/pubkey/`, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
    const body = (await res.json()) as { status?: string; pubkey?: string }
    if (res.ok && body?.pubkey?.includes('BEGIN PUBLIC KEY')) {
      pubkeyCache = { pem: body.pubkey, fetchedAt: Date.now() }
      return body.pubkey
    }
  } catch {
    // network failure → fall through to null (RSA path unavailable)
  }
  return pubkeyCache?.pem ?? null
}

/** Test hook: pre-seed the pubkey cache (used by the E2E harness). */
export function __setBlockBeePubkeyForTests(pem: string | null): void {
  pubkeyCache = pem ? { pem, fetchedAt: Date.now() } : null
}

export interface WebhookVerifyInput {
  method: 'GET' | 'POST'
  /**
   * The exact bytes BlockBee signed: for GET the full public URL
   * (protocol://host/path?query), for POST the raw request body.
   */
  signedData: string
  /** `x-ca-signature` header (base64 RSA-SHA256), when present. */
  rsaSignature: string | null
  /** `token` parameter (hex HMAC-SHA256), when present. */
  hmacToken: string | null
  /** The raw query (GET) or raw body (POST) INCLUDING the token parameter. */
  rawWithToken: string
}

export type WebhookVerifyResult =
  | { ok: true; via: 'rsa' | 'hmac' }
  | { ok: false; reason: 'no_signature' | 'rsa_unavailable' | 'bad_signature' }

/**
 * Verify a BlockBee webhook with whichever scheme is present:
 *
 *   RSA  — x-ca-signature header over the full URL (GET) / raw body (POST),
 *          verified against BlockBee's public key.
 *   HMAC — `token` param: HMAC-SHA256 (BLOCKBEE_IPN_SECRET) over the raw
 *          query/body minus the token pair itself, hex, constant-time.
 *
 * Accepted when at least one present scheme verifies. Rejected when no
 * scheme input exists, or every present input fails.
 */
export async function verifyWebhookSignature(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
  const attempts: ('rsa' | 'hmac')[] = []
  if (input.rsaSignature) attempts.push('rsa')
  if (input.hmacToken) attempts.push('hmac')
  if (attempts.length === 0) return { ok: false, reason: 'no_signature' }

  for (const scheme of attempts) {
    if (scheme === 'rsa') {
      const pem = await fetchBlockBeePublicKey()
      if (!pem) continue // RSA input present but key unfetchable → try other schemes
      try {
        const verifier = crypto.createVerify('RSA-SHA256')
        verifier.update(input.signedData, 'utf8')
        if (verifier.verify(pem, Buffer.from(input.rsaSignature as string, 'base64'))) {
          return { ok: true, via: 'rsa' }
        }
      } catch {
        // malformed signature / key mismatch → fall through
      }
    } else {
      const secret = env.BLOCKBEE_IPN_SECRET
      if (!secret) continue // HMAC input present but no secret configured
      const canonical = stripTokenParam(input.rawWithToken)
      const expected = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
      if (timingSafeHexEqual(expected, input.hmacToken as string)) {
        return { ok: true, via: 'hmac' }
      }
    }
  }

  const rsaFailed = attempts.includes('rsa')
  const hmacFailed = attempts.includes('hmac')
  if (rsaFailed && hmacFailed) return { ok: false, reason: 'bad_signature' }
  if (rsaFailed && !hmacFailed) return { ok: false, reason: 'bad_signature' } // RSA bad, HMAC unconfigured
  return { ok: false, reason: rsaFailed ? 'bad_signature' : 'rsa_unavailable' } // HMAC bad, RSA key unfetchable
}

/** Remove the `token=…` pair from a raw query string / form body, preserving order and encoding of the rest. */
export function stripTokenParam(raw: string): string {
  return raw
    .split('&')
    .filter((pair) => pair.length > 0 && !pair.startsWith('token='))
    .join('&')
}

/** Constant-time comparison of two hex digests. */
function timingSafeHexEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex.toLowerCase(), 'utf8')
  const b = Buffer.from(bHex.toLowerCase(), 'utf8')
  if (a.length !== b.length || a.length === 0) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Reconstruct the public URL a proxied request was called with — this is the
 * exact string BlockBee signs for GET webhooks. Prefers the forwarding
 * headers set by the reverse proxy (Caddy in production), falling back to
 * the Host header and the request's own path + query.
 */
export function reconstructPublicUrl(req: Request): string {
  const url = new URL(req.url)
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    (env.NODE_ENV === 'production' ? 'https' : 'http')
  const host =
    req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || url.host
  return `${proto}://${host}${url.pathname}${url.search}`
}

// ---------------------------------------------------------------------------
// IPN payload helpers
// ---------------------------------------------------------------------------

/**
 * Compute the USD value (cents) of a confirmed payment IPN.
 *
 * Preference order (all provided by BlockBee when the intention was created
 * with convert=1):
 *   1. value_coin_convert.USD  — the processor's own USD conversion
 *   2. value_coin × price      — on-chain amount × USD price at webhook time
 *   3. fallbackCents           — the intention's expected amount
 * Sanity-clamped to [$0.01, $50,000] so a garbage payload can never mint
 * absurd balances; anything outside lands in the PaymentLog for review.
 */
export function ipnUsdCents(
  params: URLSearchParams,
  fallbackCents: number,
): { cents: number; basis: 'convert' | 'price' | 'fallback' } {
  const usdFromConvert = parseConvertUsd(params.get('value_coin_convert'))
  if (usdFromConvert !== null) {
    return { cents: clampCents(usdFromConvert), basis: 'convert' }
  }
  const valueCoin = Number.parseFloat(params.get('value_coin') ?? '')
  const price = Number.parseFloat(params.get('price') ?? '')
  if (Number.isFinite(valueCoin) && Number.isFinite(price) && valueCoin > 0 && price > 0) {
    return { cents: clampCents(valueCoin * price * 100), basis: 'price' }
  }
  return { cents: clampCents(fallbackCents), basis: 'fallback' }
}

function parseConvertUsd(raw: string | null): number | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    const usd = Number.parseFloat(parsed.USD ?? '')
    if (Number.isFinite(usd) && usd > 0) return usd
  } catch {
    // not JSON / no USD key → next basis
  }
  return null
}

const MAX_CENTS_CEILING = 5_000_000 // $50,000 sanity ceiling
function clampCents(usd: number): number {
  const cents = Math.round(usd * 100)
  if (!Number.isFinite(cents) || cents < 1) return 1
  return Math.min(cents, MAX_CENTS_CEILING)
}

/** Truncate + sanitise a webhook payload for the PaymentLog (no secrets). */
export function sanitiseWebhookPayload(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of params.entries()) {
    if (k === 'token') continue // never persist signature material
    out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v
  }
  return out
}
