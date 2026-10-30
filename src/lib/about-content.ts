/**
 * ABOUT PAGE STATIC CONTENT.
 *
 * The monthly recap videos and the investor pitch deck are configured here —
 * no code changes are needed to update them, just edit and redeploy.
 *
 * Everything else on /about is dynamic:
 *   • the daily STATISTICS block is computed automatically (src/lib/stats/*)
 *   • the TEAM section lives in the TeamMember table and is managed
 *     end-to-end through the Telegram admin bot (src/lib/team.ts)
 *
 * i18n: every static LABEL on /about lives in the dictionaries
 * (src/i18n/messages/*.ts, namespace `about`) — pillar texts, section
 * headers, placeholders. This file carries only the DATA (video ids, links).
 */
export { getTeamMembers, type TeamMemberRow } from './team'

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
