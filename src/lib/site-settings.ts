/**
 * SiteSettings — the operator-managed CMS behind the Telegram admin bot.
 *
 * The admin bot's "Manage team" / "Change logo" flows write key/value rows
 * into the SiteSetting table (uploaded photos as base64 data URLs, bios as
 * plain text). Everything is read here with a short in-process cache so
 * /about, /api/favicon and other readers never add a DB round trip per
 * request — a 60-second staleness window is perfectly fine for operator
 * content.
 *
 * Keys (single source of truth — keep in sync with the bot route):
 *   current_logo_url       browser tab icon — served by /api/favicon
 *                          (never rendered as an <img> on the page)
 *   team_<member>_avatar   uploaded avatar (data URL)
 *   team_<member>_bio      bio text
 * with <member> ∈ TEAM_MEMBER_KEYS (vazima / trinity / grobofhik).
 */
import { db } from '@/lib/db'

/** Telegram-bot-editable team member keys (matches about-content.ts order). */
export const TEAM_MEMBER_KEYS = ['vazima', 'trinity', 'grobofhik'] as const
export type TeamMemberKey = (typeof TEAM_MEMBER_KEYS)[number]

export const SITE_LOGO_KEY = 'current_logo_url'

export interface TeamMemberOverride {
  avatar?: string
  bio?: string
}

export interface SiteOverrides {
  logo?: string
  team: Partial<Record<TeamMemberKey, TeamMemberOverride>>
}

// ---------------------------------------------------------------------------
// Cache (60 s TTL + explicit invalidation on write — see setSiteSetting)
// ---------------------------------------------------------------------------

const TTL_MS = 60_000
let cache: { at: number; data: SiteOverrides } | null = null

function teamKey(member: TeamMemberKey, field: 'avatar' | 'bio'): string {
  return `team_${member}_${field}`
}

function parseOverrides(rows: { key: string; value: string }[]): SiteOverrides {
  const out: SiteOverrides = { team: {} }
  for (const { key, value } of rows) {
    if (key === SITE_LOGO_KEY) {
      out.logo = value
      continue
    }
    const m = /^team_(vazima|trinity|grobofhik)_(avatar|bio)$/.exec(key)
    if (m) {
      const member = m[1] as TeamMemberKey
      const field = m[2] as 'avatar' | 'bio'
      out.team[member] = { ...(out.team[member] ?? {}), [field]: value }
    }
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

/** Human label for a member key inside bot messages. */
export function teamMemberLabel(member: TeamMemberKey): string {
  return member.charAt(0).toUpperCase() + member.slice(1)
}

export { teamKey as siteSettingTeamKey }
