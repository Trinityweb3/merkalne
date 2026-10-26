/**
 * Daily About-page statistics: computation, persistence and the worker tick.
 *
 * One snapshot per UTC day is stored in DailyStats (JSON, versioned shape —
 * see types.ts). Windows are computed relative to an `asOf` moment so the
 * worker can snapshot "now" every day AND backfill fully-elapsed past days
 * it missed while down.
 *
 * Runtime-agnostic (worker + Next routes) — no `server-only`, no `next/*`.
 * All queries use the Prisma query API (no raw SQL) so they behave identically
 * on PostgreSQL (production) and SQLite (local preview).
 */
import type { Prisma } from '@prisma/client'
import { db } from '../db'
import { statsEnv } from './config'
import {
  STATS_SNAPSHOT_VERSION,
  VISITOR_WINDOWS,
  type CountryStat,
  type SectionViews,
  type StatsSnapshot,
  type WindowStat,
  statsSnapshotSchema,
} from './types'

const WINDOW_MS: Record<(typeof VISITOR_WINDOWS)[number], number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '365d': 365 * 86_400_000,
}

/** UTC midnight of the day containing `d`. */
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** % change from previous to current, one decimal; null when there is no baseline. */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

/**
 * Unique visitors in [from, until). Implemented as groupBy(visitorId) + row
 * count — provider-portable (COUNT(DISTINCT) raw SQL differs between
 * PostgreSQL and SQLite drivers). At this site's scale the result set is tiny;
 * revisit only if unique visitors ever exceed ~10^5 per window.
 */
async function countUniqueVisitors(from: Date, until: Date): Promise<number> {
  const rows = await db.visit.groupBy({
    by: ['visitorId'],
    where: { createdAt: { gte: from, lt: until } },
  })
  return rows.length
}

/** Unique visitors per country in [from, until) — country → visitor set size. */
async function uniqueVisitorsByCountry(from: Date, until: Date): Promise<Map<string, number>> {
  const rows = await db.visit.groupBy({
    by: ['country', 'visitorId'],
    where: { createdAt: { gte: from, lt: until } },
  })
  const map = new Map<string, Set<string>>()
  for (const row of rows) {
    const set = map.get(row.country) ?? new Set<string>()
    set.add(row.visitorId)
    map.set(row.country, set)
  }
  const counts = new Map<string, number>()
  for (const [country, set] of map) counts.set(country, set.size)
  return counts
}

function withShare<T extends { views?: number; visitors?: number }>(rows: T[], key: 'views' | 'visitors'): (T & { sharePct: number })[] {
  const total = rows.reduce((sum, r) => sum + (r[key] ?? 0), 0)
  return rows.map((r) => ({
    ...r,
    sharePct: total === 0 ? 0 : Math.round(((r[key] ?? 0) / total) * 1000) / 10,
  }))
}

/**
 * Compute a full snapshot as of `asOf` (exclusive upper bound of all windows).
 * Reads only aggregated/counted data — never raw visitor rows — so the
 * snapshot itself is safe to publish.
 */
export async function computeStatsSnapshot(asOf: Date): Promise<StatsSnapshot> {
  const [visitors, viewsBySection, newPostsBySection, countriesNow, countriesPrev, premium, waitlist, publishedPosts, comments, users] =
    await Promise.all([
      // 1. Unique visitors per window + previous window for % change
      Promise.all(
        VISITOR_WINDOWS.map(async (window) => {
          const len = WINDOW_MS[window]
          const [current, previous] = await Promise.all([
            countUniqueVisitors(new Date(asOf.getTime() - len), asOf),
            countUniqueVisitors(new Date(asOf.getTime() - 2 * len), new Date(asOf.getTime() - len)),
          ])
          return { window, uniqueVisitors: current, changePct: pctChange(current, previous) } satisfies WindowStat
        }),
      ),

      // 2. Page views by section, last 7 days
      db.visit
        .groupBy({
          by: ['section'],
          _count: { _all: true },
          where: { createdAt: { gte: new Date(asOf.getTime() - WINDOW_MS['7d']), lt: asOf } },
        })
        .then((rows) =>
          withShare(
            rows
              .map((r) => ({ section: r.section, views: r._count._all }))
              .sort((a, b) => b.views - a.views)
              .slice(0, 8),
            'views',
          ) as SectionViews[],
        ),

      // 3. Posts published in the last 24h, by section
      db.post
        .groupBy({
          by: ['section'],
          _count: { _all: true },
          where: { status: 'published', publishedAt: { gte: new Date(asOf.getTime() - WINDOW_MS['24h']), lt: asOf } },
        })
        .then((rows) => rows.map((r) => ({ section: r.section, count: r._count._all }))),

      // 4. Unique visitors by country, last 30 days + previous 30 days
      uniqueVisitorsByCountry(new Date(asOf.getTime() - WINDOW_MS['30d']), asOf),
      uniqueVisitorsByCountry(new Date(asOf.getTime() - 2 * WINDOW_MS['30d']), new Date(asOf.getTime() - WINDOW_MS['30d'])),

      // 5. Active premium subscriptions (Premium+ plan values arrive with
      //    stage-2 billing — until then premiumPlus is honestly 0).
      db.user.count({
        where: { plan: 'premium', OR: [{ premiumUntil: null }, { premiumUntil: { gt: asOf } }] },
      }),

      // 6. Ads waitlist (running-advertiser campaigns arrive with the Ads launch)
      db.waitlistEntry.count({ where: { source: 'ads' } }),

      // 7. Site totals
      db.post.count({ where: { status: 'published' } }),
      db.comment.count(),
      db.user.count(),
    ])

  const countryTotal = [...countriesNow.values()].reduce((a, b) => a + b, 0)
  const countries: CountryStat[] = [...countriesNow.entries()]
    .map(([code, visitors]) => ({
      code,
      visitors,
      sharePct: countryTotal === 0 ? 0 : Math.round((visitors / countryTotal) * 1000) / 10,
      changePct: pctChange(visitors, countriesPrev.get(code) ?? 0),
    }))
    .sort((a, b) => b.visitors - a.visitors)
    .slice(0, 10)

  return {
    version: STATS_SNAPSHOT_VERSION,
    generatedAt: asOf.toISOString(),
    visitors,
    viewsBySection,
    newPostsBySection,
    premium: { premium, premiumPlus: 0 },
    advertisers: { activeCampaigns: 0, waitlist },
    countries,
    totals: { publishedPosts, comments, users },
  }
}

/** Insert-or-replace the snapshot for a UTC day (idempotent). */
export async function upsertDailyStats(day: Date, snapshot: StatsSnapshot): Promise<void> {
  await db.dailyStats.upsert({
    where: { date: day },
    create: { date: day, data: snapshot as unknown as Prisma.InputJsonValue },
    update: { data: snapshot as unknown as Prisma.InputJsonValue },
  })
}

/**
 * Compute + persist a snapshot as of `asOf`, with an audit-trail entry.
 * Used by the worker tick (actor "worker"), the admin route ("admin") and the
 * demo seeding script ("demo").
 */
export async function computeAndSaveSnapshot(asOf: Date, actor: string): Promise<{ date: Date; data: StatsSnapshot }> {
  const day = utcMidnight(asOf)
  const data = await computeStatsSnapshot(asOf)
  await upsertDailyStats(day, data)
  try {
    await db.ingestionLog.create({
      data: {
        source: 'worker-stats',
        action: 'snapshot',
        ok: true,
        detail: `asOf=${asOf.toISOString()}`,
        actor,
      },
    })
  } catch {
    // audit trail is best-effort — the snapshot itself already persisted
  }
  return { date: day, data }
}

/**
 * Latest validated snapshot for public rendering. Returns null when nothing
 * is stored yet (fresh deploy) or when a stored payload fails validation
 * (e.g. a future snapshot version written by a newer build).
 */
export async function getLatestDailyStats(): Promise<{ date: Date; data: StatsSnapshot } | null> {
  const row = await db.dailyStats.findFirst({ orderBy: { date: 'desc' } })
  if (!row) return null
  const parsed = statsSnapshotSchema.safeParse(row.data)
  if (!parsed.success) {
    console.warn('[stats] stored snapshot failed validation — ignoring (version mismatch?)')
    return null
  }
  return { date: row.date, data: parsed.data }
}

/**
 * Worker tick: once per UTC day, after STATS_SNAPSHOT_UTC_HOUR, compute
 * today's snapshot; then backfill fully-elapsed missed days (worker downtime).
 * Safe to call as often as STATS_CHECK_INTERVAL_SECONDS — existing snapshots
 * are never recomputed.
 */
export async function runStatsTick(now: Date = new Date()): Promise<{ computed: string[]; snapshotHour: number }> {
  const todayMid = utcMidnight(now)
  const computed: string[] = []

  const todayExists = await db.dailyStats.findUnique({ where: { date: todayMid }, select: { id: true } })
  if (!todayExists && now.getUTCHours() >= statsEnv.STATS_SNAPSHOT_UTC_HOUR) {
    await computeAndSaveSnapshot(now, 'worker')
    computed.push(todayMid.toISOString().slice(0, 10))
  }

  for (let d = 1; d <= statsEnv.STATS_BACKFILL_DAYS; d++) {
    const day = new Date(todayMid.getTime() - d * 86_400_000)
    const exists = await db.dailyStats.findUnique({ where: { date: day }, select: { id: true } })
    if (exists) continue
    // windows for a past day end at that day's UTC midnight
    await computeAndSaveSnapshot(day, 'worker-backfill')
    computed.push(day.toISOString().slice(0, 10))
  }

  return { computed, snapshotHour: statsEnv.STATS_SNAPSHOT_UTC_HOUR }
}
