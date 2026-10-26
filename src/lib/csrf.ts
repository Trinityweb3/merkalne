import 'server-only'
import crypto from 'node:crypto'
import { cookies } from 'next/headers'
import { authSecret, env } from '@/lib/env'

/**
 * CSRF protection — two independent layers:
 *
 * 1. Origin / Referer validation: browsers always attach an Origin header to
 *    cross-site POSTs, so a mismatch reliably identifies cross-site requests.
 * 2. Double-submit cookie: a non-HttpOnly cookie `merklane_csrf` must be echoed
 *    back in the `X-CSRF-Token` header. Subdomain-attacker sites can set
 *    cookies, but they cannot *read* this one to echo it.
 */

export const CSRF_COOKIE = 'merklane_csrf'
export const CSRF_HEADER = 'x-csrf-token'

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** Ensure the CSRF cookie exists; returns the current token. */
export async function ensureCsrfToken(): Promise<string> {
  const store = await cookies()
  const existing = store.get(CSRF_COOKIE)?.value
  if (existing && existing.length >= 20) return existing
  const token = generateCsrfToken()
  store.set(CSRF_COOKIE, token, {
    httpOnly: false, // must be readable by our own JS to echo back
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  })
  return token
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Throws when a mutating request does not originate from our own site. */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin')
  const referer = req.headers.get('referer')

  // Same-origin browser requests may omit Origin (e.g. same-site GETs), but a
  // mutating request that *has* an Origin must match. If Origin is absent we
  // fall back to Referer; if both are absent, reject — our own frontend always
  // sends at least one.
  const candidates = [origin, referer].filter(Boolean).map((v) => originOf(v as string))

  if (candidates.length === 0) {
    throw new CsrfError('Missing Origin/Referer header')
  }

  const appOrigin = originOf(env.APP_URL) as string
  const allowed = new Set<string>([appOrigin])
  // Allow the direct request host when different from APP_URL (e.g. preview hosts).
  try {
    const host = req.headers.get('host')
    if (host) {
      const proto = req.headers.get('x-forwarded-proto') ?? (env.NODE_ENV === 'production' ? 'https' : 'http')
      allowed.add(`${proto}://${host}`)
    }
  } catch {
    // ignore
  }

  const ok = candidates.some((c) => c && allowed.has(c))
  if (!ok) {
    throw new CsrfError('Cross-site request blocked')
  }
}

/** Double-submit cookie check. */
export async function assertCsrfToken(req: Request): Promise<void> {
  const header = req.headers.get(CSRF_HEADER)
  const store = await cookies()
  const cookie = store.get(CSRF_COOKIE)?.value
  if (!header || !cookie || header.length < 20 || cookie.length < 20) {
    throw new CsrfError('CSRF token missing')
  }
  // Constant-time compare.
  const a = Buffer.from(header)
  const b = Buffer.from(cookie)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new CsrfError('CSRF token mismatch')
  }
}

/** Full guard for mutating endpoints. */
export async function assertMutationSafe(req: Request): Promise<void> {
  assertSameOrigin(req)
  await assertCsrfToken(req)
}

export class CsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsrfError'
  }
}

// ---------------------------------------------------------------------------
// Generic crypto helpers
// ---------------------------------------------------------------------------

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function hmac(value: string, secret: string = authSecret): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/**
 * Signed, expiring state payload for OAuth redirects:
 * `${nonce}.${expiryUnix}.${hmac(nonce + '.' + expiryUnix)}`
 */
export function signState(ttlMs = 10 * 60 * 1000): { state: string; nonce: string } {
  const nonce = randomToken(24)
  const exp = Date.now() + ttlMs
  const state = `${nonce}.${exp}.${hmac(`${nonce}.${exp}`)}`
  return { state, nonce }
}

export function verifyState(state: string | null | undefined): boolean {
  if (!state) return false
  const parts = state.split('.')
  if (parts.length !== 3) return false
  const [nonce, exp, sig] = parts
  if (!timingSafeEqualStr(sig, hmac(`${nonce}.${exp}`))) return false
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || Date.now() > expNum) return false
  return true
}
