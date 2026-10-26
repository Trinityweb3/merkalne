/**
 * ABOUT PAGE CONTENT — THE ONE FILE YOU EDIT.
 *
 * Everything below renders on /about: the team cards, the monthly recap
 * videos and the investor pitch deck. No code changes are needed to update
 * any of it — edit the arrays/objects and redeploy.
 *
 * The daily STATISTICS block in between is different: it is computed
 * automatically (see src/lib/stats/*) and is NOT configured here.
 */

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export interface TeamMember {
  /** Display name. */
  name: string
  /** Role shown under the name, e.g. "Founder & Editor". */
  role: string
  /** Two–four sentences. Shown verbatim on the card. */
  bio: string
  /**
   * Optional photo/avatar URL (any public image). When omitted the card
   * renders a generated initials avatar — no placeholder assets needed.
   */
  imageUrl?: string
  /** Public links: label + URL. Internal paths ("/contact") work too. */
  links: { label: string; url: string }[]
}

/**
 * Add a card per person. Avatar photos are optional — leave imageUrl out and
 * the initials avatar renders automatically (the "accounts" presence comes
 * from the links, e.g. Telegram / X / GitHub profiles).
 */
export const TEAM_MEMBERS: TeamMember[] = [
  {
    name: 'McQween',
    role: 'Founder & Editor',
    bio: 'Builds and runs Merklane: collects the opportunities, edits every section and keeps the nothing-invented policy honest. Background in Web3 market research and community moderation.',
    links: [
      { label: 'Contact', url: '/contact' },
      // { label: 'Telegram', url: 'https://t.me/your_handle' },
      // { label: 'X', url: 'https://x.com/your_handle' },
      // { label: 'GitHub', url: 'https://github.com/your_handle' },
    ],
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
 * the deck is available on request and points to /contact.
 */
export const PITCH_DECK: { url: string | null; note?: string } = {
  url: null,
  note: 'What the funding is for, site expenses, roadmap and results — updated with every monthly recap.',
}
