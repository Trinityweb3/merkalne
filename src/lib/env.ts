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
  // LibreTranslate (self-hosted machine translation of job content).
  // Empty/absent = feature off: localized pages serve the English original.
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
