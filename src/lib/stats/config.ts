/**
 * About-page statistics configuration.
 *
 * Every variable is OPTIONAL with a sane default, following the bots/config
 * pattern: optional, env-overridable, never boot-crashing.
 *
 * Runtime-agnostic on purpose: imported by Next.js route handlers AND by the
 * standalone Bun worker (worker/worker.ts) — no `server-only`, no `next/*`.
 */
import { z } from 'zod'

/** ".env.example" placeholders and compose `${VAR:-}` expanders produce "" — treat as unset. */
function emptyToUndefined(v: unknown): unknown {
  return typeof v === 'string' && v.trim() === '' ? undefined : v
}

const bool = (def: boolean) =>
  z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).default(def ? 'true' : 'false').transform((v) => v === 'true'),
  )

const int = (min: number, max: number, def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def))

const statsEnvSchema = z.object({
  // --- Beacon (POST /api/track) ----------------------------------------------
  /** Master switch for the anonymous page-view beacon. */
  TRACKING_ENABLED: bool(true),
  /** Same visitor + same page counts once per this window (minutes). */
  TRACK_DEDUPE_MINUTES: int(1, 1440, 30),

  // --- Worker: daily snapshot --------------------------------------------------
  /** UTC hour at which the daily About-page snapshot is computed (0–23). */
  STATS_SNAPSHOT_UTC_HOUR: int(0, 23, 3),
  /** How often the worker checks whether a snapshot is due (seconds). */
  STATS_CHECK_INTERVAL_SECONDS: int(60, 86_400, 900),
  /** How many missed past days to backfill snapshots for (0 = disabled). */
  STATS_BACKFILL_DAYS: int(0, 30, 7),
})

const parsed = statsEnvSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`Invalid stats environment variables:\n${issues}\nCheck .env against .env.example`)
}

export const statsEnv = parsed.data
