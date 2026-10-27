/**
 * ABOUT PAGE CONTENT — THE ONE FILE YOU EDIT.
 *
 * Everything below renders on /about: the team cards, the monthly recap
 * videos and the investor pitch deck. No code changes are needed to update
 * any of it — edit the arrays/objects and redeploy.
 *
 * The daily STATISTICS block in between is different: it is computed
 * automatically (see src/lib/stats/*) and is NOT configured here.
 *
 * i18n: every static LABEL on /about lives in the dictionaries
 * (src/i18n/messages/*.ts, namespace `about`) — team role labels, pillar
 * texts, section headers. This file carries only the DATA (names, links,
 * video ids). Team social links come from the environment
 * (SOCIAL_VAZIMA_URL / SOCIAL_TRINITY_URL / SOCIAL_GROBOFHIK_URL) so they
 * can be changed without a rebuild.
 */
import { env } from './env'

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

/** Keys of the `about` dictionary namespace used for role labels. */
export type TeamRoleKey = 'roleCeo' | 'roleProgrammer'

export interface TeamMember {
  /** Display name. */
  name: string
  /**
   * Role label — an i18n key (namespace `about`), so the role renders in the
   * visitor's language. Add new roles to every dictionary file first.
   */
  roleKey: TeamRoleKey
  /**
   * Two–four sentences. Shown verbatim on the card. Empty/omitted → the
   * localized "Bio coming soon." placeholder (about.bioPlaceholder).
   */
  bio?: string
  /**
   * Optional photo/avatar URL (any public image). When omitted the card
   * renders a generated initials avatar — no placeholder assets needed.
   */
  imageUrl?: string
  /**
   * Public profile link. When set the whole card becomes a clickable link
   * that opens in a new tab. Sourced from the environment per member.
   */
  socialUrl?: string
}

/**
 * The Merklane team. Social links come from env (see the header comment);
 * avatars and bios are placeholders for now — fill `imageUrl`/`bio` here
 * when ready.
 */
export const TEAM_MEMBERS: TeamMember[] = [
  {
    name: 'Vazima',
    roleKey: 'roleCeo',
    socialUrl: env.SOCIAL_VAZIMA_URL,
  },
  {
    name: 'Trinity',
    roleKey: 'roleProgrammer',
    socialUrl: env.SOCIAL_TRINITY_URL,
  },
  {
    name: 'Grobofhik',
    roleKey: 'roleProgrammer',
    socialUrl: env.SOCIAL_GROBOFHIK_URL,
  },
]

// ---------------------------------------------------------------------------
// Monthly recap videos (embedded on /about once published)
// ---------------------------------------------------------------------------

export interface MonthlyRecap {
  /** Card headline, e.g. "October recap — first full month". */
  title: string
  /** Just the video id from a YouTube URL (watch?v=THIS part). */
  youtubeId: string
  /** ISO date (YYYY-MM-DD) — rendered as "October 2026". */
  publishedAt: string
  /** Optional one-liner under the title. */
  description?: string
}

/**
 * Empty for now — the page renders an honest "first recap after the first
 * full month" placeholder. Add entries topmost-first, e.g.:
 *
 *   { title: 'October recap', youtubeId: 'dQw4w9WgXcQ',
 *     publishedAt: '2026-10-31', description: 'Traction, roadmap and how to support us.' }
 */
export const MONTHLY_RECAPS: MonthlyRecap[] = []

// ---------------------------------------------------------------------------
// Investor pitch deck
// ---------------------------------------------------------------------------

/**
 * Set `url` to a public PDF (e.g. your object storage / docs link) and the
 * page renders an "Open the deck" button. While null the page honestly says
 * the deck is available on request and points to /contact. The default note
 * text is localized (about.pitchNote); set `note` to override it verbatim.
 */
export const PITCH_DECK: { url: string | null; note?: string } = {
  url: null,
}
