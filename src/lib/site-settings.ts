/**
 * SiteSettings — the operator-managed CMS behind the Telegram admin bot.
 *
 * The admin bot's "Change logo" flow writes a key/value row into the
 * SiteSetting table (uploaded photos as base64 data URLs). Everything is read
 * here with a short in-process cache so /api/favicon and other readers never
 * add a DB round trip per request — a 60-second staleness window is perfectly
 * fine for operator content.
 *
 * Keys (single source of truth — keep in sync with the bot route):
 *   current_logo_url   browser tab icon — served by /api/favicon
 *                      (never rendered as an <img> on the page)
 *
 * Team content NO LONGER lives here: the /about team section is fully dynamic
 * through the TeamMember table (see src/lib/team.ts). The legacy
 * team_<member>_bio / team_<member>_avatar rows are merged into TeamMember
 * rows once by the lazy seed in team.ts and are not read afterwards.
 */
import { db } from '@/lib/db'

export const SITE_LOGO_KEY = 'current_logo_url'

export interface SiteOverrides {
  logo?: string
}

// ---------------------------------------------------------------------------
// Cache (60 s TTL + explicit invalidation on write — see setSiteSetting)
// ---------------------------------------------------------------------------

const TTL_MS = 60_000
let cache: { at: number; data: SiteOverrides } | null = null

function parseOverrides(rows: { key: string; value: string }[]): SiteOverrides {
  const out: SiteOverrides = {}
  for (const { key, value } of rows) {
    if (key === SITE_LOGO_KEY) out.logo = value
  }
  return out
}

/** All operator overrides (cached 60 s). Safe to call on every request. */
export async function getSiteOverrides(): Promise<SiteOverrides> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data
  const rows = await db.siteSetting.findMany()
  const data = parseOverrides(rows)
  cache = { at: Date.now(), data }
  return data
}

/** One key, uncached — used by writers to echo the new value back. */
export async function getSiteSetting(key: string): Promise<string | null> {
  const row = await db.siteSetting.findUnique({ where: { key } })
  return row?.value ?? null
}

/** Upsert one setting and drop the read cache (next read sees it immediately). */
export async function setSiteSetting(key: string, value: string): Promise<void> {
  await db.siteSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
  cache = null
}

/** Remove one setting (e.g. a bot "reset avatar" action). */
export async function clearSiteSetting(key: string): Promise<void> {
  await db.siteSetting.deleteMany({ where: { key } })
  cache = null
}
