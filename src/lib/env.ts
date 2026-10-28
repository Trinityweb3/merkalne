/**
 * Strict environment variable validation (fail fast, no silent undefined).
 * Server-side only — never import from client components.
 */
import { z } from 'zod'

/**
 * ".env.example" placeholders ship as "" — treat empty strings as unset so a
 * fresh `cp .env.example .env` boots with defaults instead of crashing.
 */
function emptyToUndefined(v: unknown): unknown {
  return typeof v === 'string' && v.trim() === '' ? undefined : v
}

const optionalStr = z.preprocess(emptyToUndefined, z.string().optional())

/** Optional http(s) URL — empty = unset; trailing slashes trimmed. */
const optionalHttpUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .regex(/^https?:\/\/.+/, 'must be an http(s) URL, e.g. https://t.me/your_handle')
    .transform((v) => v.replace(/\/+$/, ''))
    .optional(),
)

/** Optional donation addresses — validated only when set (loose, format-level). */
const optionalAddress = (min: number, max: number) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .min(min, 'address looks too short')
      .max(max, 'address looks too long')
      .refine((v) => /^[a-zA-Z0-9]+$/.test(v), 'address may only contain letters and digits')
      .optional(),
  )

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (v) => v.startsWith('postgresql://') || v.startsWith('postgres://') || v.startsWith('file:'),
      'DATABASE_URL must be a PostgreSQL connection string (or file: URL for local SQLite previews)',
    ),
  DATABASE_PROVIDER: z.enum(['postgresql', 'sqlite']).default('postgresql'),
  APP_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .url()
      .default('http://localhost:3000')
      .transform((v) => v.replace(/\/+$/, '')),
  ),
  AUTH_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  RESEND_API_KEY: optionalStr,
  EMAIL_FROM: z.preprocess(emptyToUndefined, z.string().default('Merklane <noreply@merklane.com>')),
  GOOGLE_CLIENT_ID: optionalStr,
  GOOGLE_CLIENT_SECRET: optionalStr,
  GITHUB_CLIENT_ID: optionalStr,
  GITHUB_CLIENT_SECRET: optionalStr,
  // Donation wallets (About/support sheet). All optional; the UI shows only
  // what is configured and stays honest when nothing is.
  DONATION_SOL_ADDRESS: optionalAddress(32, 48),
  DONATION_BTC_ADDRESS: optionalAddress(26, 62),
  DONATION_USDT_EVM_ADDRESS: optionalAddress(42, 42),
  // Team social links on /about (Vazima / Trinity / Grobofhik). Optional
  // http(s) URLs — a member without a link renders a non-clickable card.
  SOCIAL_VAZIMA_URL: optionalHttpUrl,
  SOCIAL_TRINITY_URL: optionalHttpUrl,
  SOCIAL_GROBOFHIK_URL: optionalHttpUrl,
  // Machine translation of job content. LLM providers are tried in priority
  // order (Groq → DeepSeek → Gemini); self-hosted LibreTranslate is the final
  // fallback. All keys optional — empty/absent = that provider is skipped;
  // when nothing at all is configured, localized pages serve the English
  // original.
  GROQ_API_KEY: optionalStr,
  DEEPSEEK_API_KEY: optionalStr,
  GOOGLE_AI_API_KEY: optionalStr,
  // Self-hosted LibreTranslate (final translation fallback).
  LIBRETRANSLATE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(/^https?:\/\/.+/, 'LIBRETRANSLATE_URL must be an http(s) URL, e.g. http://libretranslate:5000')
      .transform((v) => v.replace(/\/+$/, ''))
      .optional(),
  ),
  LIBRETRANSLATE_API_KEY: optionalStr,
  // Custom translation glossary file (Web3 jargon protection). Empty = the
  // conventional config/translation-glossary.json next to the app, if any.
  TRANSLATION_GLOSSARY_PATH: optionalStr,
  // Merklane Ads. ADS_ENABLED=false hides every <AdSlot/> (serve API answers
  // 204) — e.g. while policies are being reviewed. The top-up mode decides
  // how a deposit gets confirmed:
  //   "blockbee" — BlockBee payment processor (production): the top-up modal
  //     creates a payment intention via the BlockBee API and the IPN webhook
  //     at /api/webhooks/blockbee credits the campaign automatically.
  //   "manual" (default) — an admin confirms in the dashboard after checking
  //     the wallet, safe when no processor is configured.
  //   "simulate" — the ADVERTISER can confirm their own pending top-up
  //     (demos and local testing only).
  // Empty/unset = AUTO: "blockbee" when BLOCKBEE_API_KEY is set, else "manual".
  ADS_ENABLED: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  ),
  ADS_TOPUP_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(['manual', 'simulate', 'blockbee']).optional(),
  ),
  // Seed for the deterministic deposit-address derivation (mock HD wallet,
  // manual/simulate fallback modes only).
  ADS_TOPUP_SEED: optionalStr,
  // BlockBee payment processor (https://blockbee.io — formerly CryptAPI).
  // API key from the BlockBee dashboard. When set (and ADS_TOPUP_MODE is not
  // pinned to manual/simulate) ad top-ups run through BlockBee: the /create/
  // endpoint issues a unique deposit address per intention and the IPN
  // webhook credits the campaign balance. Referral withdrawals use the
  // BlockBee payout chain. Empty = BlockBee disabled (manual fallback).
  BLOCKBEE_API_KEY: optionalStr,
  // Shared secret for HMAC verification of BlockBee webhooks (the `token`
  // query parameter, HMAC-SHA256 over the remaining query string). The
  // production RSA scheme (x-ca-signature header) is verified as well —
  // a webhook is accepted when EITHER verification passes.
  BLOCKBEE_IPN_SECRET: optionalStr,
  // Comma-separated allowlist of BlockBee coin tickers offered for top-ups
  // and payouts. Defaults to stablecoins + major coins on cheap networks.
  // TRON tickers (trx, trc20_*) are ALWAYS rejected regardless of this list
  // (high fraud rate, client policy).
  BLOCKBEE_COINS: optionalStr,
  // Minimum referral withdrawal in US cents (default 2000 = $20.00 — below
  // that, network + processor fees eat the payout).
  BLOCKBEE_MIN_PAYOUT_CENTS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(100).max(1_000_000).default(2000),
  ),
  CORS_ALLOWED_ORIGINS: z.preprocess(emptyToUndefined, z.string().default('')),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`Invalid environment variables:\n${issues}\nCheck .env against .env.example`)
}

export const env = parsed.data

const isProduction = env.NODE_ENV === 'production'

/**
 * `next build` imports every route module during "Collecting page data",
 * which executes this file top-to-bottom. Docker builds ship no secrets on
 * purpose (.dockerignore excludes .env*) — real values arrive as the
 * container environment and belong to runtime boot, not to the builder.
 * next build sets NEXT_PHASE='phase-production-build' for exactly this
 * phase, so the boot assertion is skipped there and enforced on the actual
 * server/worker boot instead.
 */
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build'

if (isProduction && !isBuildPhase) {
  const missing: string[] = []
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) missing.push('AUTH_SECRET')
  if (!env.DATABASE_URL.startsWith('postgres')) missing.push('DATABASE_URL (PostgreSQL)')
  if (missing.length > 0) {
    throw new Error(
      `Refusing to boot in production with missing/weak settings: ${missing.join(', ')}. ` +
        'See .env.example for required values.',
    )
  }
  if (env.AUTH_SECRET?.includes('CHANGE_ME') || env.AUTH_SECRET?.includes('dev-only')) {
    throw new Error('AUTH_SECRET still contains a placeholder value. Generate a real secret.')
  }
}

if (!env.AUTH_SECRET && !isProduction) {
  // Development convenience only — a warning keeps this honest.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.warn(
      '[env] AUTH_SECRET is not set — using an ephemeral development secret. ' +
        'Sessions/CSRF will reset on restart. Set AUTH_SECRET for anything persistent.',
    )
  }
}

/** Deterministic-per-boot fallback so dev flows still work without config. */
export const authSecret: string =
  env.AUTH_SECRET ?? `ephemeral-dev-secret-${process.pid}-${Date.now()}0123456789abcdef`

export const isProd = isProduction

/** Which OAuth providers have usable credentials right now. */
export function configuredOAuthProviders() {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  }
}

/** Origins allowed for browser fetches (APP_URL origin + explicit extras). */
export function allowedOrigins(): string[] {
  const own = new URL(env.APP_URL).origin
  const extras = env.CORS_ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  return [own, ...extras]
}
