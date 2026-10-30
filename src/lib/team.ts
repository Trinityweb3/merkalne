/**
 * Team CMS — the /about team section, fully dynamic.
 *
 * Rows live in the TeamMember table and are managed end-to-end through the
 * Telegram admin bot (👥 Manage team): add new members (name → role → social
 * URL), edit name/role/bio/social, upload avatars, remove members. This
 * module is the single data-access layer both sides share:
 *
 *   /about (server component)   getTeamMembers() — ordered cards
 *   telegram-admin webhook      create/update/delete + getTeamMember(id)
 *
 * LEGACY MIGRATION (one-time, automatic): before the TeamMember table existed
 * the team was hardcoded (about-content.ts) with only bio/avatar overrides in
 * SiteSetting rows (team_<member>_bio / team_<member>_avatar). The first
 * getTeamMembers() call on an empty table seeds the three default members and
 * copies those legacy overrides into their rows — existing deployments keep
 * every operator-uploaded bio/avatar with zero manual steps.
 *
 * Caching mirrors src/lib/site-settings.ts: 60 s in-process TTL, explicit
 * invalidation on every write, so the page adds no DB round trip per request
 * while bot edits go live within a minute (or instantly on this instance).
 */
import { db } from '@/lib/db'
import { env } from '@/lib/env'

/** Field limits enforced by the bot (kept here so the page could reuse them). */
export const TEAM_LIMITS = {
  nameMin: 1,
  nameMax: 60,
  roleMax: 60,
  bioMax: 400,
  urlMax: 500,
} as const

/** Legacy SiteSetting member keys (pre-CMS era) — only used by the seed. */
const LEGACY_TEAM_KEYS = ['vazima', 'trinity', 'grobofhik'] as const

export interface TeamMemberRow {
  id: string
  name: string
  role: string
  bio: string
  avatarUrl: string | null
  socialUrl: string | null
  order: number
}

// ---------------------------------------------------------------------------
// Cache (60 s TTL + explicit invalidation on write)
// ---------------------------------------------------------------------------

const TTL_MS = 60_000
let cache: { at: number; rows: TeamMemberRow[] } | null = null

/** Drop the read cache — called by every mutating helper below. */
export function invalidateTeamCache(): void {
  cache = null
}

function toRow(m: {
  id: string
  name: string
  role: string
  bio: string
  avatarUrl: string | null
  socialUrl: string | null
  order: number
}): TeamMemberRow {
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    bio: m.bio,
    avatarUrl: m.avatarUrl,
    socialUrl: m.socialUrl,
    order: m.order,
  }
}

/** Read one legacy SiteSetting override value (null when absent). */
async function legacySetting(key: string): Promise<string | null> {
  const row = await db.siteSetting.findUnique({ where: { key }, select: { value: true } })
  return row?.value ?? null
}

/**
 * Seed the default team on an EMPTY table, merging legacy SiteSetting
 * overrides (team_<member>_bio / team_<member>_avatar) so operator content
 * from the pre-CMS era survives. Idempotent: the emptiness check plus
 * createMany means a race between two first reads can at worst duplicate the
 * seed, which the order-stable sort keeps visually identical — and the very
 * next write path never runs against an empty table again.
 */
async function seedDefaults(): Promise<void> {
  const [vazimaBio, vazimaAvatar, trinityBio, trinityAvatar, grobofhikBio, grobofhikAvatar] =
    await Promise.all([
      legacySetting('team_vazima_bio'),
      legacySetting('team_vazima_avatar'),
      legacySetting('team_trinity_bio'),
      legacySetting('team_trinity_avatar'),
      legacySetting('team_grobofhik_bio'),
      legacySetting('team_grobofhik_avatar'),
    ])

  const rows = [
    {
      name: 'Vazima',
      role: 'CEO',
      bio: vazimaBio ?? '',
      avatarUrl: vazimaAvatar,
      socialUrl: env.SOCIAL_VAZIMA_URL ?? null,
      order: 0,
    },
    {
      name: 'Trinity',
      role: 'Programmer',
      bio: trinityBio ?? '',
      avatarUrl: trinityAvatar,
      socialUrl: env.SOCIAL_TRINITY_URL ?? null,
      order: 1,
    },
    {
      name: 'Grobofhik',
      role: 'Programmer',
      bio: grobofhikBio ?? '',
      avatarUrl: grobofhikAvatar,
      socialUrl: env.SOCIAL_GROBOFHIK_URL ?? null,
      order: 2,
    },
  ]

  await db.teamMember.createMany({ data: rows })
}

/**
 * All team members for /about, ordered by `order` ascending (creation time
 * breaks ties). Cached 60 s. On an empty table: seed defaults, then re-read.
 */
export async function getTeamMembers(): Promise<TeamMemberRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows

  let rows = await db.teamMember.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] })
  if (rows.length === 0) {
    await seedDefaults()
    rows = await db.teamMember.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] })
  }

  const out = rows.map(toRow)
  cache = { at: Date.now(), rows: out }
  return out
}

/** One member by id (uncached) — used by the bot before edits/removal. */
export async function getTeamMember(id: string): Promise<TeamMemberRow | null> {
  const m = await db.teamMember.findUnique({ where: { id } })
  return m ? toRow(m) : null
}

/** Next free sort position (appends at the end of the list). */
export async function nextTeamOrder(): Promise<number> {
  const last = await db.teamMember.findFirst({ orderBy: { order: 'desc' }, select: { order: true } })
  return (last?.order ?? -1) + 1
}

// ---------------------------------------------------------------------------
// Mutations (bot only) — each invalidates the cache
// ---------------------------------------------------------------------------

export async function createTeamMember(input: {
  name: string
  role: string
  socialUrl?: string | null
  bio?: string
  avatarUrl?: string | null
}): Promise<TeamMemberRow> {
  const created = await db.teamMember.create({
    data: {
      name: input.name,
      role: input.role,
      bio: input.bio ?? '',
      avatarUrl: input.avatarUrl ?? null,
      socialUrl: input.socialUrl ?? null,
      order: await nextTeamOrder(),
    },
  })
  invalidateTeamCache()
  return toRow(created)
}

const EDITABLE_FIELDS = ['name', 'role', 'bio', 'socialUrl', 'avatarUrl'] as const
type EditableField = (typeof EDITABLE_FIELDS)[number]

export async function updateTeamMember(
  id: string,
  patch: Partial<Pick<TeamMemberRow, EditableField>>,
): Promise<TeamMemberRow | null> {
  const updated = await db.teamMember
    .update({ where: { id }, data: patch })
    .catch(() => null) // unknown id (prisma P2025) → null, caller handles it
  if (updated) invalidateTeamCache()
  return updated ? toRow(updated) : null
}

export async function deleteTeamMember(id: string): Promise<boolean> {
  const deleted = await db.teamMember
    .delete({ where: { id } })
    .then(() => true)
    .catch(() => false)
  if (deleted) invalidateTeamCache()
  return deleted
}
