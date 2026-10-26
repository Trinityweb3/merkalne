/**
 * Versioned shape of a DailyStats snapshot (stored as JSON in the DailyStats
 * table, served by GET /api/stats/latest, rendered on /about).
 *
 * DESIGN RULE — i18n-ready without a locale API:
 *   The snapshot carries RAW NUMBERS and neutral identifiers only (section
 *   slugs, ISO country codes, ISO timestamps). No labels, no formatted
 *   strings, no localized text. All presentation lives in the UI, so when a
 *   language/locale endpoint API is added later, translating the About page
 *   means translating labels — the data layer never changes.
 */
import { z } from 'zod'

export const STATS_SNAPSHOT_VERSION = 1

export const VISITOR_WINDOWS = ['24h', '7d', '30d', '365d'] as const
export type VisitorWindow = (typeof VISITOR_WINDOWS)[number]

/** Unique visitors for one window + % change vs the previous equal-length window. */
export interface WindowStat {
  window: VisitorWindow
  uniqueVisitors: number
  /** null = no baseline yet (previous window had zero visitors) — UI shows "—". */
  changePct: number | null
}

/** Page views per section over a fixed window (currently 7 days). */
export interface SectionViews {
  section: string
  views: number
  /** Share of all views in the window, 0–100 (one decimal). */
  sharePct: number
}

/** Posts published in the last 24h, grouped by section. */
export interface NewPostsBySection {
  section: string
  count: number
}

/** Unique visitors per country over a fixed window (currently 30 days). */
export interface CountryStat {
  /** ISO 3166-1 alpha-2 code; "XX" = unknown (no geo header present). */
  code: string
  visitors: number
  sharePct: number
  /** % change vs the previous equal-length window (null = no baseline). */
  changePct: number | null
}

export interface StatsSnapshot {
  version: number
  /** ISO timestamp — when this snapshot was computed ("as of"). */
  generatedAt: string
  /** Unique visitors per window, order: 24h, 7d, 30d, 365d. */
  visitors: WindowStat[]
  /** Page views by section (window: last 7 days before generatedAt). */
  viewsBySection: SectionViews[]
  /** Posts published in the 24h before generatedAt, by section. */
  newPostsBySection: NewPostsBySection[]
  /** Active subscriptions at generatedAt. Premium+ arrives with stage-2 billing. */
  premium: { premium: number; premiumPlus: number }
  /** Advertisers. Active campaigns arrive with the Ads launch; waitlist is live. */
  advertisers: { activeCampaigns: number; waitlist: number }
  /** Unique visitors per country (window: last 30 days before generatedAt), top 10. */
  countries: CountryStat[]
  /** Site totals at generatedAt. */
  totals: { publishedPosts: number; comments: number; users: number }
}

/** Zod mirror of StatsSnapshot — validates JSON coming back out of the DB. */
export const statsSnapshotSchema: z.ZodType<StatsSnapshot> = z.object({
  version: z.number().int(),
  generatedAt: z.string(),
  visitors: z.array(
    z.object({
      window: z.enum(VISITOR_WINDOWS),
      uniqueVisitors: z.number().int(),
      changePct: z.number().nullable(),
    }),
  ),
  viewsBySection: z.array(
    z.object({
      section: z.string(),
      views: z.number().int(),
      sharePct: z.number(),
    }),
  ),
  newPostsBySection: z.array(
    z.object({
      section: z.string(),
      count: z.number().int(),
    }),
  ),
  premium: z.object({ premium: z.number().int(), premiumPlus: z.number().int() }),
  advertisers: z.object({ activeCampaigns: z.number().int(), waitlist: z.number().int() }),
  countries: z.array(
    z.object({
      code: z.string().length(2),
      visitors: z.number().int(),
      sharePct: z.number(),
      changePct: z.number().nullable(),
    }),
  ),
  totals: z.object({
    publishedPosts: z.number().int(),
    comments: z.number().int(),
    users: z.number().int(),
  }),
})
