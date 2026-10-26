/**
 * Bots & workers configuration.
 *
 * Every bot variable is OPTIONAL with a sane default — the app boots and every
 * flow degrades honestly (503 + explanation) when a bot is not configured,
 * mirroring the OAuth provider behaviour.
 *
 * Runtime-agnostic on purpose: this module is imported by Next.js route
 * handlers AND by the standalone Bun worker (worker/worker.ts). It therefore
 * avoids `server-only` and any `next/*` import.
 */
import { z } from 'zod'

/** ".env.example" placeholders and compose `${VAR:-}` expanders produce "" — treat as unset. */
function emptyToUndefined(v: unknown): unknown {
  return typeof v === 'string' && v.trim() === '' ? undefined : v
}

/** Optional string: "" → undefined → schema default, instead of a boot crash. */
const optionalStr = (min: number, refine?: { check: (v: string) => boolean; message: string }) =>
  z.preprocess(
    emptyToUndefined,
    refine
      ? z.string().trim().min(min).refine(refine.check, refine.message).optional()
      : z.string().trim().min(min).optional(),
  )

const botEnvSchema = z.object({
  // --- Telegram ingestion + alerts -----------------------------------------
  TELEGRAM_BOT_TOKEN: optionalStr(1),
  TELEGRAM_WEBHOOK_SECRET: optionalStr(16),
  TELEGRAM_ADMIN_USER_IDS: optionalStr(1),
  TELEGRAM_BOT_USERNAME: optionalStr(4, {
    check: (v) => /^[A-Za-z0-9_]{4,32}$/.test(v),
    message: 'TELEGRAM_BOT_USERNAME must be the bare @BotFather name, e.g. merklane_admin_bot',
  }),

  // --- Discord ingestion + alerts ------------------------------------------
  DISCORD_APPLICATION_ID: optionalStr(1),
  DISCORD_BOT_PUBLIC_KEY: optionalStr(64, {
    check: (v) => /^[0-9a-fA-F]{64}$/.test(v),
    message: 'DISCORD_BOT_PUBLIC_KEY must be the 64-char hex key from the Discord developer portal',
  }),
  DISCORD_BOT_TOKEN: optionalStr(1),
  DISCORD_ADMIN_USER_IDS: optionalStr(1),

  // --- Worker (ingestion feeds + premium dispatch) ---------------------------
  WORKER_ENABLED: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  ),
  WORKER_INGEST_INTERVAL_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(60).max(86_400).default(300),
  ),
  WORKER_DISPATCH_INTERVAL_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(10).max(86_400).default(60),
  ),
  INGEST_FEED_URLS: z.preprocess(emptyToUndefined, z.string().trim().default('')),
  AUTO_PUBLISH_INGESTED_JOBS: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ),
  NOTIFICATION_RETRY_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(10).default(3),
  ),
  NOTIFICATION_EMAIL_CONCURRENCY: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(16).default(4),
  ),
  NOTIFICATIONS_SUBJECT_PREFIX: z.preprocess(
    emptyToUndefined,
    z.string().trim().max(60).default('[Merklane Jobs]'),
  ),

  // Shared with the app env (re-parsed here so the worker stays standalone).
  AUTH_SECRET: optionalStr(16),
  RESEND_API_KEY: optionalStr(1),
  EMAIL_FROM: z.preprocess(
    emptyToUndefined,
    z.string().default('Merklane <noreply@merklane.com>'),
  ),
  APP_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .url()
      .default('http://localhost:3000')
      .transform((v) => v.replace(/\/+$/, '')),
  ),
})

const parsed = botEnvSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`Invalid bot environment variables:\n${issues}\nCheck .env against .env.example`)
}

export const botEnv = parsed.data

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * The webhook endpoint is secured (TELEGRAM_WEBHOOK_SECRET set) and can
 * accept Telegram updates. Sending replies separately requires the token —
 * without it messages are console-logged (dev fallback).
 */
export function telegramWebhookConfigured(): boolean {
  return Boolean(botEnv.TELEGRAM_WEBHOOK_SECRET)
}

/** Telegram job ingestion + premium DM alerts are fully configured. */
export function telegramEnabled(): boolean {
  return Boolean(botEnv.TELEGRAM_BOT_TOKEN && botEnv.TELEGRAM_BOT_USERNAME)
}

/** The /start deep-link prefix users click to attach their chat for alerts. */
export function telegramDeepLink(path = ''): string {
  const bot = botEnv.TELEGRAM_BOT_USERNAME ?? 'your_bot'
  return `https://t.me/${bot}${path ? `?start=${path}` : ''}`
}

/** Discord slash-command ingestion is fully configured. */
export function discordIngestionEnabled(): boolean {
  return Boolean(botEnv.DISCORD_APPLICATION_ID && botEnv.DISCORD_BOT_PUBLIC_KEY)
}

/** Discord slash-command registration (scripts/register-discord-commands.ts). */
export function discordRegistrationEnabled(): boolean {
  return Boolean(discordIngestionEnabled() && botEnv.DISCORD_BOT_TOKEN)
}

/** External feed URLs the worker ingests jobs from. */
export function ingestFeedUrls(): string[] {
  return botEnv.INGEST_FEED_URLS
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Admin allowlists, parsed once. */
export function telegramAdminIds(): Set<string> {
  return new Set(
    (botEnv.TELEGRAM_ADMIN_USER_IDS ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

export function discordAdminIds(): Set<string> {
  return new Set(
    (botEnv.DISCORD_ADMIN_USER_IDS ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/** Secret used for webhook authentication (Telegram header / signing). */
export const telegramWebhookSecret: string | undefined = botEnv.TELEGRAM_WEBHOOK_SECRET
