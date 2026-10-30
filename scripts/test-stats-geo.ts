/// <reference types="bun-types" />
/**
 * Unit tests for the visitor-stats geolocation fix (no server needed):
 *
 *   • countryFromHeaders (src/lib/stats/track.ts)
 *       — cf-ipcountry is read FIRST and wins over later geo headers
 *       — Cloudflare special values: "XX" (unknown) and "T1" (Tor) fall
 *         through to the remaining headers instead of masking a real country
 *       — values are trimmed + upper-cased; garbage never becomes a country
 *       — honest "XX" when nothing usable is present
 *
 *   • clientIp (src/lib/rate-limit.ts)
 *       — CF-Connecting-IP wins over X-Forwarded-For (CRITICAL behind
 *         Cloudflare + Caddy: the local proxy overwrites XFF with the CF
 *         edge IP, which used to collapse every visitor into a few
 *         fingerprints/rate buckets)
 *       — X-Forwarded-For uses the leftmost (original client) entry
 *       — x-real-ip / 'unknown' fallbacks intact
 *
 * VPN policy: the exit-node country is recorded as-is — statistics only,
 * NO blocking anywhere.
 */
import { countryFromHeaders, UNKNOWN_COUNTRY } from '@/lib/stats/track'
import { clientIp } from '@/lib/rate-limit'

let failures = 0

function ok(label: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [ok]   ${label}`)
  else {
    failures += 1
    console.log(`  [FAIL] ${label} ${extra}`)
  }
}

/** A Request carrying the given headers (header names are case-insensitive). */
function req(headers: Record<string, string>): Request {
  return new Request('https://merklane.test/api/track', { method: 'POST', headers })
}

console.log('— countryFromHeaders —')

ok(
  'cf-ipcountry wins over every later geo header',
  countryFromHeaders(req({ 'cf-ipcountry': 'US', 'x-geo-country': 'DE' }).headers) === 'US',
)
ok('cf-ipcountry lower-case is upper-cased', countryFromHeaders(req({ 'cf-ipcountry': 'de' }).headers) === 'DE')
ok('cf-ipcountry padded/whitespace is trimmed', countryFromHeaders(req({ 'cf-ipcountry': '  US  ' }).headers) === 'US')
ok(
  'CF "XX" (unknown) falls through to a real country in later headers',
  countryFromHeaders(req({ 'cf-ipcountry': 'XX', 'x-geo-country': 'FR' }).headers) === 'FR',
)
ok(
  'CF "T1" (Tor) is skipped, not stored as a country',
  countryFromHeaders(req({ 'cf-ipcountry': 'T1', 'x-country-code': 'NL' }).headers) === 'NL',
)
ok('CF "T1" with no fallback → honest XX', countryFromHeaders(req({ 'cf-ipcountry': 'T1' }).headers) === UNKNOWN_COUNTRY)
ok('garbage 3-letter value never becomes a country', countryFromHeaders(req({ 'cf-ipcountry': 'USA' }).headers) === UNKNOWN_COUNTRY)
ok('no geo headers at all → XX', countryFromHeaders(req({}).headers) === UNKNOWN_COUNTRY)
ok('x-vercel-ip-country used when CF absent', countryFromHeaders(req({ 'x-vercel-ip-country': 'JP' }).headers) === 'JP')
ok('plain x-country-code used when CF absent', countryFromHeaders(req({ 'x-country-code': 'BR' }).headers) === 'BR')

console.log('— clientIp —')

ok(
  'CF-Connecting-IP beats the proxy-rewritten X-Forwarded-For',
  clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '104.16.1.1' })) === '203.0.113.7',
)
ok('X-Forwarded-For uses the leftmost (original client) entry', clientIp(req({ 'x-forwarded-for': '203.0.113.5, 70.41.3.18' })) === '203.0.113.5')
ok('x-real-ip fallback intact', clientIp(req({ 'x-real-ip': '198.51.100.9' })) === '198.51.100.9')
ok('no headers → unknown', clientIp(req({})) === 'unknown')
ok(
  'CF-Connecting-IP also wins over x-real-ip',
  clientIp(req({ 'cf-connecting-ip': '203.0.113.8', 'x-real-ip': '104.16.2.2' })) === '203.0.113.8',
)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
process.exit(failures === 0 ? 0 : 1)
