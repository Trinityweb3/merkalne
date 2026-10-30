/**
 * Sliding-window rate limiter (in-process).
 *
 * Sufficient for a single Node instance. For multi-instance deployments swap
 * the store for Redis/Upstash — the interface below is intentionally tiny so
 * the swap is a one-file change.
 */

interface Bucket {
  hits: number[]
}

const buckets = new Map<string, Bucket>()
let lastSweep = Date.now()

const SWEEP_INTERVAL_MS = 60_000

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    // Drop buckets whose newest hit is older than 1 hour.
    if (bucket.hits.length === 0 || now - bucket.hits[bucket.hits.length - 1] > 3_600_000) {
      buckets.delete(key)
    }
  }
}

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfterSeconds: number
}

/**
 * @param key       Unique bucket key, e.g. `login:1.2.3.4`
 * @param limit     Max requests inside the window
 * @param windowMs  Window size in milliseconds
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  sweep(now)
  const bucket = buckets.get(key) ?? { hits: [] }
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs)

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0]
    buckets.set(key, bucket)
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    }
  }

  bucket.hits.push(now)
  buckets.set(key, bucket)
  return { ok: true, remaining: limit - bucket.hits.length, retryAfterSeconds: 0 }
}

/**
 * Extract a best-effort client IP from proxy headers.
 *
 * Priority order — CRITICAL behind Cloudflare + a local reverse proxy:
 *   1. CF-Connecting-IP — Cloudflare's dedicated header carrying the TRUE
 *      visitor IP. Must be read FIRST: the local proxy (Caddy) overwrites
 *      X-Forwarded-For with its immediate peer, which behind Cloudflare is a
 *      CF EDGE IP — every visitor would then share a handful of
 *      fingerprints/rate buckets.
 *   2. X-Forwarded-For — first (leftmost, original client) entry.
 *   3. X-Real-IP — classic single-hop proxy header.
 * Used for rate limiting and the anonymous stats fingerprint — never stored.
 */
export function clientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip')
  if (cf && cf.trim()) return cf.trim()
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}
