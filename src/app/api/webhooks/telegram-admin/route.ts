import { db } from '@/lib/db'
import { jsonError, jsonOk } from '@/lib/api'
import { rateLimit } from '@/lib/rate-limit'
import { botEnv, telegramAdminIds, telegramAdminWebhookConfigured } from '@/lib/bots/config'
import {
  parseTelegramCommand,
  tgEscape,
  telegramAnswerCallbackQuery,
  telegramDownloadAsDataUrl,
  telegramEditMessageText,
  telegramSendMessage,
  telegramSendPhoto,
  type TelegramInlineButton,
  type TelegramUpdate,
} from '@/lib/bots/telegram'
import {
  createJobFromSpec,
  grantPremium,
  intakeStats,
  listRecentJobs,
  parseAddJobArgs,
  publishPostById,
  revokePremium,
  type JobIntakeSpec,
} from '@/lib/bots/intake'
import { parseBulkJobText } from '@/lib/bots/bulk-parse'
import { POST_SECTIONS, SECTION_META } from '@/lib/constants'
import {
  SITE_LOGO_KEY,
  setSiteSetting,
} from '@/lib/site-settings'
import {
  TEAM_LIMITS,
  createTeamMember,
  deleteTeamMember,
  getTeamMember,
  getTeamMembers,
  updateTeamMember,
  type TeamMemberRow,
} from '@/lib/team'
import {
  approveCampaign,
  listModerationQueue,
  moderationPreviewLines,
  rejectCampaign,
  REJECT_REASON_MAX,
  REJECT_REASON_MIN,
  type ModerationQueueItem,
} from '@/lib/ads/moderation'
import { formatMicroUsd } from '@/lib/ads/money'
import { logAdminAction, resolveTelegramAdminActor } from '@/lib/ads/audit'

/**
 * POST /api/webhooks/telegram-admin — the ADMIN INTAKE BOT webhook.
 *
 * This is the second, role-separated Telegram bot (TELEGRAM_ADMIN_BOT_TOKEN —
 * a different bot from @BotFather than the user-facing notifier). The split:
 *
 *   notifier bot (TELEGRAM_BOT_TOKEN)          admin intake bot (this route)
 *   ─ premium alert DMs (worker)               ─ bulk-paste job composer
 *   ─ /start account linking                   ─ inline-button confirmation
 *   ─ /alerts on|off · /unlink · /whoami       ─ /jobs /publish /stats /grant
 *
 * Bulk-paste composer (state in TelegramAdminState, one draft per admin):
 *   ➕ Add job → paste the RAW job text (any format) → the parser extracts
 *   Title / Company / URL / Section / Body / level / workplace / … → the
 *   parsed draft comes back as a confirmation card with inline buttons:
 *   ✅ Publish · 📝 Save draft · 🔄 Section (re-pick) · ❌ Cancel.
 *   Pasting again at any point simply re-parses — no step-by-step typing.
 *
 * Security (server-to-server — CSRF not applicable):
 *   • X-Telegram-Bot-Api-Secret-Token must equal TELEGRAM_ADMIN_WEBHOOK_SECRET
 *     (set via setWebhook — scripts/set-telegram-webhook.ts registers BOTH bots)
 *   • EVERY update (message or callback) must come from TELEGRAM_ADMIN_USER_IDS
 *   • per-chat sliding-window rate limit; all free-text Zod-validated in intake
 *   • every action lands in IngestionLog
 *
 * Always 200 to Telegram (errors become bot replies) so the Bot API never
 * retries admin mistakes.
 */

const HELP_TEXT = [
  '<b>Merklane admin intake bot</b>',
  '',
  '<b>Bulk paste (the fast path)</b>',
  '➕ Add job → paste the raw job text in any format.',
  'I parse Title, Company, URL, Section, Body automatically —',
  'labeled lines ("Company: X") and plain pastes both work.',
  'Confirm the parsed fields with the inline buttons. Done.',
  '',
  '<b>Site content (CMS)</b>',
  '👥 Manage team — add, edit or remove /about team members:',
  'name, role, bio, avatar photo, social link — all from Telegram.',
  '🖼 Change logo — upload the browser tab icon (favicon).',
  'Changes go live within a minute (60 s cache).',
  '',
  '<b>Ads moderation</b>',
  '🛡 Moderation Queue — every campaign submitted for review:',
  'preview the creative (banner images included), then',
  '✅ Approve (goes live) or ❌ Reject (with a reason the',
  'advertiser sees in their dashboard).',
  '',
  '<b>Power commands</b>',
  '/addjob Title | Company | URL | Section | tags,comma [key=value…]',
  '/jobs [n] — recent postings · /publish &lt;id&gt;',
  '',
  '<b>Premium</b>',
  '/grant email 30 — add 30 premium days · /revoke email',
  '',
  'Notifier bot (alerts to users) is a separate bot — see TELEGRAM_BOT_TOKEN.',
].join('\n')

// ---------------------------------------------------------------------------
// Keyboard builders
// ---------------------------------------------------------------------------

type Keyboard = { inline_keyboard: TelegramInlineButton[][] }

const cb = (text: string, data: string): TelegramInlineButton => ({ text, callback_data: data })
const row = (...buttons: TelegramInlineButton[]): TelegramInlineButton[] => buttons

const mainMenu: Keyboard = {
  inline_keyboard: [
    row(cb('➕ Add job', 'new')),
    row(cb('📋 Recent jobs', 'jobs'), cb('📊 Stats', 'stats')),
    row(cb('🛡 Moderation Queue', 'mod')),
    row(cb('👥 Manage team', 'team'), cb('🖼 Change logo', 'logo')),
    row(cb('❓ Help', 'help')),
  ],
}

/** Team CMS root: one button per DB member + add-new + back. */
function teamMenuKeyboard(members: TeamMemberRow[]): Keyboard {
  return {
    inline_keyboard: [
      ...members.map((m) =>
        row(cb(`👤 ${m.name}${m.role ? ` · ${m.role}` : ''}`, `member:${m.id}`)),
      ),
      row(cb('➕ Add New Member', 'teamadd')),
      row(cb('⬅️ Menu', 'menu')),
    ],
  }
}

/** Per-member actions: every field of the /about card is editable. */
function memberMenuKeyboard(id: string): Keyboard {
  return {
    inline_keyboard: [
      row(cb('✏️ Edit Name', `mname:${id}`), cb('✏️ Edit Role', `mrole:${id}`)),
      row(cb('📝 Edit Bio', `mbio:${id}`), cb('🖼 Upload Avatar', `mavatar:${id}`)),
      row(cb('🔗 Edit Social URL', `msocial:${id}`)),
      row(cb('🗑 Remove Member', `mremove:${id}`)),
      row(cb('⬅️ Team', 'team'), cb('⬅️ Menu', 'menu')),
    ],
  }
}

/** Destructive removal is a two-tap action — confirm first. */
function removeConfirmKeyboard(id: string): Keyboard {
  return {
    inline_keyboard: [
      row(cb('🗑 Yes, remove', `mremove2:${id}`)),
      row(cb('⬅️ Keep member', `member:${id}`)),
    ],
  }
}

// ---------------------------------------------------------------------------
// Ads moderation queue (🛡 Moderation Queue)
// ---------------------------------------------------------------------------

/** Queue root: one button per PENDING campaign (oldest first) + back. */
function moderationQueueKeyboard(items: ModerationQueueItem[]): Keyboard {
  return {
    inline_keyboard: [
      ...items.map((item) =>
        row(
          cb(
            `${item.campaign.format === 'banner' ? '🖼' : '📝'} ${item.campaign.name.slice(0, 40)} — v${item.creative?.version ?? 1}`,
            `modv:${item.campaign.id}`,
          ),
        ),
      ),
      row(cb('🔄 Refresh', 'mod')),
      row(cb('⬅️ Menu', 'menu')),
    ],
  }
}

/** One pending campaign: the moderator's decision. */
function moderationItemKeyboard(campaignId: string): Keyboard {
  return {
    inline_keyboard: [
      row(cb('✅ Approve', `modok:${campaignId}`), cb('❌ Reject', `modno:${campaignId}`)),
      row(cb('⬅️ Queue', 'mod'), cb('⬅️ Menu', 'menu')),
    ],
  }
}

/** Queue list text (HTML) — the review backlog, oldest first. */
function moderationQueueText(items: ModerationQueueItem[]): string {
  if (items.length === 0) {
    return ['<b>🛡 Moderation Queue</b>', '', 'No campaigns waiting for review — advertisers submit them from the wizard (Step 5).'].join('\n')
  }
  const lines = ['<b>🛡 Moderation Queue</b>', '', `${items.length} campaign${items.length === 1 ? '' : 's'} waiting (oldest first):`, '']
  for (const item of items) {
    const c = item.campaign
    const bid =
      c.billingModel === 'cpc'
        ? `${formatMicroUsd(c.bidMicroUsd)}/click`
        : `${formatMicroUsd(c.bidMicroUsd)}/1000 views`
    lines.push(
      `${c.format === 'banner' ? '🖼' : '📝'} <b>${esc(c.name)}</b> · ${c.billingModel.toUpperCase()} · ${bid} · budget ${formatMicroUsd(c.totalBudgetMicroUsd)}`,
      `    by ${esc(item.advertiserEmail)}`,
    )
  }
  lines.push('', 'Tap a campaign to preview and decide.')
  return lines.join('\n')
}

/**
 * Editable member fields, keyed by callback action: each carries the CMS
 * state to save (typed factory — keeps the CmsTarget discriminated union
 * intact) and the prompt copy rendered while awaiting input.
 */
const MEMBER_FIELD_ACTIONS: Record<
  string,
  { cms: (id: string) => CmsTarget; prompt: (m: TeamMemberRow) => string[] }
> = {
  mname: {
    cms: (id) => ({ kind: 'name', memberId: id }),
    prompt: (m) => [
      `<b>✏️ Name for ${esc(m.name)}</b>`,
      '',
      `Send the new name (${TEAM_LIMITS.nameMin}\u2013${TEAM_LIMITS.nameMax} characters). The card updates within a minute.`,
      '',
      '<i>Send /cancel to abort.</i>',
    ],
  },
  mrole: {
    cms: (id) => ({ kind: 'role', memberId: id }),
    prompt: (m) => [
      `<b>✏️ Role for ${esc(m.name)}</b>`,
      '',
      `Send the new role / job title shown under the name (up to ${TEAM_LIMITS.roleMax} characters), or <code>clear</code> to remove it.`,
      `Current: ${m.role ? esc(m.role) : '—'}`,
      '',
      '<i>Send /cancel to abort.</i>',
    ],
  },
  mbio: {
    cms: (id) => ({ kind: 'bio', memberId: id }),
    prompt: (m) => [
      `<b>📝 Bio for ${esc(m.name)}</b>`,
      '',
      `Send the new bio as plain text (up to ${TEAM_LIMITS.bioMax} characters), or <code>clear</code> to remove it.`,
      `Current: ${m.bio ? `${m.bio.length} characters` : '—'}`,
      'The current bio is replaced completely.',
      '',
      '<i>Send /cancel to abort.</i>',
    ],
  },
  msocial: {
    cms: (id) => ({ kind: 'social', memberId: id }),
    prompt: (m) => [
      `<b>🔗 Social link for ${esc(m.name)}</b>`,
      '',
      'Send the public profile URL (https://t.me/\u2026, LinkedIn, GitHub, \u2026) — the whole /about card becomes this link — or <code>clear</code> to remove it.',
      `Current: ${m.socialUrl ? esc(m.socialUrl) : '—'}`,
      '',
      '<i>Send /cancel to abort.</i>',
    ],
  },
  mavatar: {
    cms: (id) => ({ kind: 'avatar', memberId: id }),
    prompt: (m) => [
      `<b>🖼 Avatar for ${esc(m.name)}</b>`,
      '',
      'Send the photo now — square works best (rendered at 56px).',
      'The current avatar is replaced completely.',
      '',
      '<i>Send /cancel to abort.</i>',
    ],
  },
}

const cancelOnlyKeyboard: Keyboard = { inline_keyboard: [row(cb('❌ Cancel', 'abort'))] }

/** Section picker shown while a parsed draft awaits confirmation. */
const sectionPickerKeyboard: Keyboard = {
  inline_keyboard: [
    row(cb('🧑‍🎓 Intern / Junior', 'sec:intern-junior'), cb('🧑‍💻 Mid / Senior', 'sec:mid-senior')),
    row(cb('🚀 Opportunities', 'sec:opportunities'), cb('📈 Markets', 'sec:markets')),
    row(cb('🔎 Insights', 'sec:insights'), cb('✍️ Blog', 'sec:blog')),
    row(cb('⬅️ Back to review', 'back')),
  ],
}

const pastePromptKeyboard: Keyboard = { inline_keyboard: [row(cb('❌ Cancel', 'abort'))] }

const confirmKeyboard: Keyboard = {
  inline_keyboard: [
    row(cb('✅ Publish now', 'pub'), cb('📝 Save draft', 'draft')),
    row(cb('🔄 Change section', 'picksec'), cb('❌ Cancel', 'abort')),
  ],
}

// ---------------------------------------------------------------------------
// Paste / confirm state (TelegramAdminState)
// ---------------------------------------------------------------------------

type Step = 'paste' | 'confirm' | 'cms' | 'moderation'

// NOTE: a type alias (not an interface) — object *type aliases* receive an
// implicit index signature, which is what makes this assignable to Prisma's
// InputJsonObject when the draft is persisted to TelegramAdminState.draft.
type Draft = {
  spec?: JobIntakeSpec
  guesses?: string[]
  /** CMS flow target while step === 'cms' (team CMS, site logo). */
  cms?: CmsTarget
  /** Moderation flow target while step === 'moderation'. */
  moderation?: ModerationTarget
}

/** Team CMS state — what the next non-command message means. */
type CmsTarget =
  | { kind: 'logo' }
  | { kind: 'avatar'; memberId: string }
  | { kind: 'bio'; memberId: string }
  | { kind: 'name'; memberId: string }
  | { kind: 'role'; memberId: string }
  | { kind: 'social'; memberId: string }
  | { kind: 'add-member'; step: 'name' | 'role' | 'social'; name?: string; role?: string }

/** Ads moderation state — the pending rejection reason capture. */
type ModerationTarget = { kind: 'reject-reason'; campaignId: string }

function esc(s: string): string {
  return tgEscape(s)
}

function sectionLabel(section: string | undefined): string {
  if (!section) return '—'
  const meta = SECTION_META[section as keyof typeof SECTION_META]
  return meta ? meta.title : section
}

/** Compact member card for bot messages (bio truncated for chat). */
function memberSummary(m: TeamMemberRow): string {
  const bio = m.bio ? (m.bio.length > 120 ? `${m.bio.slice(0, 117)}…` : m.bio) : ''
  return [
    `<b>👤 ${esc(m.name)}</b>${m.role ? ` — ${esc(m.role)}` : ''}`,
    bio ? `Bio: ${esc(bio)}` : 'Bio: —',
    `Avatar: ${m.avatarUrl ? 'photo' : 'initials'} · Social: ${m.socialUrl ? esc(m.socialUrl) : '—'} · Position: ${m.order + 1}`,
  ].join('\n')
}

/** Validate operator-supplied http(s) URL; null when invalid. */
function parseSocialUrl(raw: string): string | null {
  const url = raw.trim()
  if (url.length > TEAM_LIMITS.urlMax) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

async function getState(adminUserId: string): Promise<{ step: Step; draft: Draft } | null> {
  const row = await db.telegramAdminState.findUnique({ where: { adminUserId } })
  if (!row) return null
  return { step: row.step as Step, draft: (row.draft ?? {}) as Draft }
}

async function setState(adminUserId: string, step: Step, draft: Draft): Promise<void> {
  await db.telegramAdminState.upsert({
    where: { adminUserId },
    update: { step, draft },
    create: { adminUserId, step, draft },
  })
}

async function clearState(adminUserId: string): Promise<void> {
  await db.telegramAdminState.deleteMany({ where: { adminUserId } })
}

// ---------------------------------------------------------------------------
// Transport helpers (admin bot token)
// ---------------------------------------------------------------------------

const TOKEN = botEnv.TELEGRAM_ADMIN_BOT_TOKEN

function send(chatId: string | number, html: string, keyboard?: Keyboard) {
  return telegramSendMessage(chatId, html, { token: TOKEN, replyMarkup: keyboard })
}

function edit(chatId: string | number, messageId: number | undefined, html: string, keyboard?: Keyboard) {
  return telegramEditMessageText(chatId, messageId, html, { token: TOKEN, replyMarkup: keyboard })
}

// ---------------------------------------------------------------------------
// Confirmation card
// ---------------------------------------------------------------------------

const PASTE_PROMPT = [
  '<b>📋 Paste the job posting</b>',
  '',
  'Send the raw text in any format — forwarded posts, "Company: X" style',
  'labels, or just a plain description all work. I will extract the title,',
  'company, apply URL, section, salary, level and body automatically and',
  'show you the parsed result for confirmation.',
].join('\n')

function summaryText(spec: JobIntakeSpec, guesses: string[]): string {
  const lines = [
    '<b>Parsed — review &amp; publish</b>',
    '',
    `▸ Section: ${sectionLabel(spec.section)}`,
    `▸ Title: ${esc(spec.title)}`,
    `▸ Company: ${spec.company ? esc(spec.company) : '—'}`,
    `▸ Location: ${spec.location ? esc(spec.location) : '—'}`,
    `▸ Workplace: ${spec.workplace ?? '—'}`,
    `▸ Employment: ${spec.employment ?? '—'}`,
    `▸ Level: ${spec.level ?? '—'}`,
    `▸ Salary: ${spec.salary ? esc(spec.salary) : '—'}`,
    `▸ Stack: ${spec.stack ? esc(spec.stack) : '—'}`,
    `▸ Apply URL: ${spec.applyUrl ? esc(spec.applyUrl) : '—'}`,
    `▸ Tags: ${spec.tags.length > 0 ? esc(spec.tags.join(', ')) : '—'}`,
    `▸ Body: ${spec.body ? `${spec.body.length} chars` : 'auto-generated'}`,
  ]
  if (guesses.length > 0) {
    lines.push('', '<i>Parser guesses (check these):</i>')
    for (const g of guesses) lines.push(`<i>⚠️ ${esc(g)}</i>`)
  }
  lines.push('', '<i>Send a new paste any time to re-parse from scratch.</i>')
  return lines.join('\n')
}

async function publishDraft(
  adminUserId: string,
  chatId: string,
  spec: JobIntakeSpec,
  publish: boolean,
  fromId: string,
): Promise<void> {
  const result = await createJobFromSpec({ ...spec, publish }, { source: 'telegram', actor: `tg-admin:${fromId}` })
  await clearState(adminUserId)

  if (!result.ok) {
    await send(chatId, `⚠️ ${result.message}\nDraft discarded — /start to begin again.`)
    return
  }
  const url = `${botEnv.APP_URL}/${result.post.section}/${result.post.slug}`
  await send(
    chatId,
    [
      result.post.deduped
        ? `♻️ Already in the database:\n<b>${esc(result.post.title)}</b>`
        : `${publish ? '✅ Published' : '📝 Draft saved'}:\n<b>${esc(result.post.title)}</b>`,
      `id: <code>${result.post.id}</code>`,
      url,
      result.post.status === 'draft' ? `Publish later: /publish ${result.post.id}` : 'Premium alerts are being dispatched.',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// Update handlers
// ---------------------------------------------------------------------------

async function handleCallback(update: TelegramUpdate, fromId: string, chatId: string): Promise<void> {
  const cq = update.callback_query!
  const data = cq.data ?? ''
  const messageId = cq.message?.message_id
  void telegramAnswerCallbackQuery(cq.id, undefined, { token: TOKEN })

  const state = await getState(fromId)

  if (data === 'menu') {
    await clearState(fromId)
    await edit(chatId, messageId, '<b>Admin menu</b>\nWhat do you want to do?', mainMenu)
    return
  }
  if (data === 'help') {
    await edit(chatId, messageId, HELP_TEXT, mainMenu)
    return
  }
  if (data === 'jobs') {
    const jobs = await listRecentJobs(8)
    await edit(
      chatId,
      messageId,
      jobs.length === 0
        ? 'No postings yet — add the first with ➕ Add job.'
        : jobs
            .map((j) => `[${j.status === 'draft' ? '📝' : '🟢'}] <code>${j.id.slice(-6)}</code> · ${esc(j.title)} — ${esc(j.company ?? '?')} (${j.section})`)
            .join('\n'),
      { inline_keyboard: [row(cb('⬅️ Menu', 'menu')), row(cb('➕ Add job', 'new'))] },
    )
    return
  }
  if (data === 'stats') {
    const s = await intakeStats()
    await edit(
      chatId,
      messageId,
      [
        '<b>Pipeline</b>',
        `Published: ${s.published} · Drafts: ${s.drafts}`,
        `Waitlist: ${s.waitlist}`,
        `Active premium: ${s.premium}`,
        `Alerts pending: ${s.pendingAlerts} · failed: ${s.failedAlerts}`,
      ].join('\n'),
      { inline_keyboard: [row(cb('⬅️ Menu', 'menu'))] },
    )
    return
  }
  if (data === 'new') {
    await setState(fromId, 'paste', {})
    await edit(chatId, messageId, PASTE_PROMPT, pastePromptKeyboard)
    return
  }
  if (data === 'abort') {
    await clearState(fromId)
    await edit(chatId, messageId, '❌ Cancelled. Nothing was saved.', mainMenu)
    return
  }

  // --- Site CMS: team members (dynamic TeamMember table) + site logo -------
  if (data === 'team') {
    await clearState(fromId)
    const members = await getTeamMembers()
    await edit(
      chatId,
      messageId,
      [
        '<b>👥 Manage team</b>',
        members.length === 0
          ? 'No members yet — add the first one with ➕ Add New Member.'
          : `Pick a member to edit, or add a new one.\n${members.length} member${members.length === 1 ? '' : 's'} on /about, in card order.`,
      ].join('\n'),
      teamMenuKeyboard(members),
    )
    return
  }
  if (data === 'teamadd') {
    await setState(fromId, 'cms', { cms: { kind: 'add-member', step: 'name' } })
    await edit(
      chatId,
      messageId,
      [
        '<b>➕ Add a new team member</b>',
        '',
        '<b>Step 1/3 — Name</b>',
        `Send the display name (${TEAM_LIMITS.nameMin}\u2013${TEAM_LIMITS.nameMax} characters).`,
        '',
        '<i>Send /cancel to abort \u2014 nothing is saved until the last step.</i>',
      ].join('\n'),
      cancelOnlyKeyboard,
    )
    return
  }
  if (data === 'logo') {
    await setState(fromId, 'cms', { cms: { kind: 'logo' } })
    await edit(
      chatId,
      messageId,
      [
        '<b>🖼 Change the site logo</b>',
        '',
        'Send the logo as a photo now (square works best — it becomes the',
        'favicon, the little icon in the browser tab). I will download it,',
        'store it and tabs pick it up within a minute.',
        '',
        '<i>Send /cancel to abort.</i>',
      ].join('\n'),
      cancelOnlyKeyboard,
    )
    return
  }
  if (data.startsWith('member:')) {
    const id = data.slice(7)
    const member = await getTeamMember(id)
    if (!member) {
      await telegramAnswerCallbackQuery(cq.id, 'Member not found — refresh with ⬅️ Team.', { token: TOKEN, showAlert: true })
      return
    }
    await clearState(fromId)
    await edit(chatId, messageId, `${memberSummary(member)}\n\nWhat do you want to change?`, memberMenuKeyboard(member.id))
    return
  }

  // Per-member edit prompts: mname/mrole/mbio/msocial/mavatar/mremove(+confirm).
  const memberAction = /^(mname|mrole|mbio|msocial|mavatar|mremove2?):(.+)$/.exec(data)
  if (memberAction) {
    const [, action, id] = memberAction
    const member = await getTeamMember(id)
    if (!member) {
      await telegramAnswerCallbackQuery(cq.id, 'Member not found — refresh with ⬅️ Team.', { token: TOKEN, showAlert: true })
      return
    }

    if (action === 'mremove') {
      await clearState(fromId)
      await edit(
        chatId,
        messageId,
        [
          `<b>🗑 Remove ${esc(member.name)}?</b>`,
          '',
          'The member disappears from /about immediately (60 s cache).',
          'This cannot be undone — you would have to add them again.',
        ].join('\n'),
        removeConfirmKeyboard(id),
      )
      return
    }
    if (action === 'mremove2') {
      await clearState(fromId)
      const gone = await deleteTeamMember(id)
      await edit(
        chatId,
        messageId,
        gone
          ? `🗑 <b>${esc(member.name)}</b> removed from /about.`
          : `⚠️ Could not remove ${esc(member.name)} — already gone?`,
        teamMenuKeyboard(await getTeamMembers()),
      )
      if (gone) {
        await db.ingestionLog
          .create({ data: { source: 'telegram', action: 'team-remove', actor: `tg-admin:${fromId}`, detail: id } })
          .catch(() => undefined)
      }
      return
    }

    const field = MEMBER_FIELD_ACTIONS[action]
    if (!field) return // unreachable — the regex only matches known actions
    await setState(fromId, 'cms', { cms: field.cms(id) })
    await edit(chatId, messageId, field.prompt(member).join('\n'), cancelOnlyKeyboard)
    return
  }

  // --- Ads moderation queue (🛡): mod / modv / modok / modno -----------------
  if (data === 'mod') {
    await clearState(fromId)
    const items = await listModerationQueue()
    await edit(chatId, messageId, moderationQueueText(items), moderationQueueKeyboard(items))
    return
  }
  if (data.startsWith('modv:')) {
    const campaignId = data.slice(5)
    const items = await listModerationQueue()
    const item = items.find((i) => i.campaign.id === campaignId)
    if (!item) {
      await telegramAnswerCallbackQuery(cq.id, 'Not in the queue anymore — refreshing.', { token: TOKEN, showAlert: true })
      await edit(chatId, messageId, moderationQueueText(await listModerationQueue()), moderationQueueKeyboard(await listModerationQueue()))
      return
    }
    await clearState(fromId)
    const caption = moderationPreviewLines(esc, item).join('\n')
    // Banner campaigns: show the actual image. Telegram must be able to
    // fetch it, so the local upload path becomes an absolute APP_URL URL;
    // when that fails (unreachable host, dev tunnel down) the preview
    // falls back to a text card so moderation never blocks.
    if (item.campaign.format === 'banner' && item.creative?.imageUrl) {
      const photoUrl = `${botEnv.APP_URL.replace(/\/+$/, '')}${item.creative.imageUrl}`
      const keyboard = moderationItemKeyboard(campaignId)
      const sent = await telegramSendPhoto(chatId, photoUrl, caption, {
        token: TOKEN,
        replyMarkup: { inline_keyboard: keyboard.inline_keyboard },
      })
      if (sent.delivered || sent.devFallback) return
      // Photo undeliverable — text preview instead (imageUrl noted).
      await edit(
        chatId,
        messageId,
        [...moderationPreviewLines(esc, item), '', '<i>(The banner image could not be previewed here — check it in the dashboard.)</i>'].join('\n'),
        moderationItemKeyboard(campaignId),
      )
      return
    }
    await edit(chatId, messageId, caption, moderationItemKeyboard(campaignId))
    return
  }
  if (data.startsWith('modok:')) {
    const campaignId = data.slice(6)
    const result = await approveCampaign(campaignId, `tg-admin:${fromId}`)
    if (!result.ok) {
      await telegramAnswerCallbackQuery(cq.id, result.message, { token: TOKEN, showAlert: true })
      await edit(chatId, messageId, moderationQueueText(await listModerationQueue()), moderationQueueKeyboard(await listModerationQueue()))
      return
    }
    await edit(
      chatId,
      messageId,
      ['✅ <b>Campaign approved</b>', '', 'It is now ACTIVE and enters the auction immediately.', '', 'Queue after this decision:'].join('\n') +
        '\n' +
        moderationQueueText(await listModerationQueue()),
      moderationQueueKeyboard(await listModerationQueue()),
    )
    return
  }
  if (data.startsWith('modno:')) {
    const campaignId = data.slice(6)
    const items = await listModerationQueue()
    if (!items.some((i) => i.campaign.id === campaignId)) {
      await telegramAnswerCallbackQuery(cq.id, 'Not in the queue anymore — refreshing.', { token: TOKEN, showAlert: true })
      await edit(chatId, messageId, moderationQueueText(items), moderationQueueKeyboard(items))
      return
    }
    await setState(fromId, 'moderation', { moderation: { kind: 'reject-reason', campaignId } })
    await edit(
      chatId,
      messageId,
      [
        '❌ <b>Reject this campaign</b>',
        '',
        'Send the rejection reason now — the advertiser sees it verbatim in',
        `their dashboard next to the rejected campaign (${REJECT_REASON_MIN}\u2013${REJECT_REASON_MAX} characters).`,
        '',
        '<i>Send /cancel to abort without rejecting.</i>',
      ].join('\n'),
      cancelOnlyKeyboard,
    )
    return
  }

  // --- everything below needs a parsed draft awaiting confirmation ----------
  if (data === 'back') {
    if (!state || state.step !== 'confirm' || !state.draft.spec) {
      await edit(chatId, messageId, PASTE_PROMPT, pastePromptKeyboard)
      return
    }
    await edit(chatId, messageId, summaryText(state.draft.spec, state.draft.guesses ?? []), confirmKeyboard)
    return
  }
  if (data === 'picksec') {
    if (!state || state.step !== 'confirm' || !state.draft.spec) {
      await telegramAnswerCallbackQuery(cq.id, 'Nothing to re-section — paste a job first.', { token: TOKEN, showAlert: true })
      return
    }
    await edit(chatId, messageId, `Pick the section for:\n<b>${esc(state.draft.spec.title)}</b>`, sectionPickerKeyboard)
    return
  }
  if (data.startsWith('sec:')) {
    const section = data.slice(4)
    if (!(POST_SECTIONS as readonly string[]).includes(section)) {
      await telegramAnswerCallbackQuery(cq.id, 'Unknown section.', { token: TOKEN, showAlert: true })
      return
    }
    if (!state || state.step !== 'confirm' || !state.draft.spec) {
      await telegramAnswerCallbackQuery(cq.id, 'Nothing to re-section — paste a job first.', { token: TOKEN, showAlert: true })
      return
    }
    const spec = { ...state.draft.spec, section: section as JobIntakeSpec['section'] }
    const guesses = (state.draft.guesses ?? []).filter((g) => !g.startsWith('Section'))
    await setState(fromId, 'confirm', { spec, guesses })
    await edit(chatId, messageId, summaryText(spec, guesses), confirmKeyboard)
    return
  }
  if (data === 'pub' || data === 'draft') {
    if (!state || state.step !== 'confirm' || !state.draft.spec) {
      await telegramAnswerCallbackQuery(cq.id, 'Nothing parsed yet — tap ➕ Add job and paste a job first.', { token: TOKEN, showAlert: true })
      return
    }
    await publishDraft(fromId, chatId, state.draft.spec, data === 'pub', fromId)
    return
  }
  await telegramAnswerCallbackQuery(cq.id, 'Unknown button — /start', { token: TOKEN, showAlert: true })
}

// ---------------------------------------------------------------------------
// Team CMS text capture (step 'cms')
// ---------------------------------------------------------------------------

/**
 * Non-command text while step === 'cms': routed by the cms target saved in
 * the admin's draft. Covers the ➕ Add-member wizard (name → role → social)
 * and every per-field edit of an existing member. Every path validates its
 * input length/shape and re-renders a sane next step on bad input.
 */
async function handleCmsText(fromId: string, chatId: string, cms: CmsTarget, text: string): Promise<void> {
  const clean = text.trim()

  // --- ➕ Add-member wizard -------------------------------------------------
  if (cms.kind === 'add-member') {
    if (cms.step === 'name') {
      if (clean.length < TEAM_LIMITS.nameMin || clean.length > TEAM_LIMITS.nameMax || clean.includes('\n')) {
        await send(chatId, `⚠️ Name must be ${TEAM_LIMITS.nameMin}\u2013${TEAM_LIMITS.nameMax} characters on one line. Try again, or /cancel.`)
        return
      }
      await setState(fromId, 'cms', { cms: { ...cms, step: 'role', name: clean } })
      await send(
        chatId,
        [
          `✅ Name: <b>${esc(clean)}</b>`,
          '',
          '<b>Step 2/3 \u2014 Role</b>',
          'Send the role / job title shown under the name (e.g. \u201cCEO\u201d,',
          '\u201cProgrammer\u201d, \u201cHead of Content\u201d), or send <code>skip</code> for none.',
          '',
          '<i>Send /cancel to abort \u2014 nothing is saved yet.</i>',
        ].join('\n'),
      )
      return
    }
    if (cms.step === 'role') {
      const role = /^skip$/i.test(clean) ? '' : clean
      // 'skip' yields an EMPTY role by design — validate the raw input, not
      // the emptied result, or the explicit skip is rejected as too short.
      if (!clean || clean.includes('\n') || role.length > TEAM_LIMITS.roleMax) {
        await send(chatId, `⚠️ Role must be 1\u2013${TEAM_LIMITS.roleMax} characters (or <code>skip</code>). Try again, or /cancel.`)
        return
      }
      await setState(fromId, 'cms', { cms: { ...cms, step: 'social', role } })
      await send(
        chatId,
        [
          `✅ Role: <b>${role ? esc(role) : '\u2014'}</b>`,
          '',
          '<b>Step 3/3 \u2014 Social link</b>',
          'Send the public profile URL (https://t.me/\u2026, LinkedIn, GitHub, \u2026) \u2014',
          'the whole /about card becomes this link \u2014 or <code>skip</code> for no link.',
          '',
          '<i>Send /cancel to abort \u2014 nothing is saved yet.</i>',
        ].join('\n'),
      )
      return
    }
    // step === 'social' — final step, everything is saved now.
    let socialUrl: string | null = null
    if (!/^skip$/i.test(clean)) {
      const parsed = parseSocialUrl(clean)
      if (!parsed) {
        await send(chatId, '⚠️ That does not look like a link. Send a URL starting with http:// or https://, or <code>skip</code>.')
        return
      }
      socialUrl = parsed
    }
    const name = cms.name ?? ''
    if (!name) {
      await clearState(fromId)
      await send(chatId, '⚠️ Lost the draft \u2014 start again from \u200b👥 Manage team \u2192 ➕ Add New Member.', mainMenu)
      return
    }
    const created = await createTeamMember({ name, role: cms.role ?? '', socialUrl })
    await clearState(fromId)
    await send(
      chatId,
      [
        `✅ <b>${esc(created.name)}</b> added to /about${created.role ? ` as ${esc(created.role)}` : ''}${created.socialUrl ? ' \u2014 the card links to their profile' : ''}.`,
        'Visible within a minute (60 s cache).',
      ].join('\n'),
      memberMenuKeyboard(created.id),
    )
    await db.ingestionLog
      .create({ data: { source: 'telegram', action: 'team-add', actor: `tg-admin:${fromId}`, detail: created.id } })
      .catch(() => undefined)
    return
  }

  // --- Per-field edits on an existing member --------------------------------
  if (cms.kind === 'logo') return // logo expects a photo, not text
  const member = await getTeamMember(cms.memberId)
  if (!member) {
    await clearState(fromId)
    await send(chatId, '⚠️ That member no longer exists — start again from 👥 Manage team.', mainMenu)
    return
  }

  const done = async (line: string, action: string): Promise<void> => {
    await clearState(fromId)
    await send(chatId, line, memberMenuKeyboard(member.id))
    await db.ingestionLog
      .create({ data: { source: 'telegram', action, actor: `tg-admin:${fromId}`, detail: `${member.id} · ${member.name}` } })
      .catch(() => undefined)
  }

  if (cms.kind === 'avatar') {
    await send(chatId, '📷 I am waiting for a photo for this member — send the image, or /cancel.')
    return
  }
  if (cms.kind === 'name') {
    if (clean.length < TEAM_LIMITS.nameMin || clean.length > TEAM_LIMITS.nameMax || clean.includes('\n')) {
      await send(chatId, `⚠️ Name must be ${TEAM_LIMITS.nameMin}\u2013${TEAM_LIMITS.nameMax} characters on one line. Try again, or /cancel.`)
      return
    }
    await updateTeamMember(member.id, { name: clean })
    await done(`✅ Name updated: <b>${esc(clean)}</b>.\n/about picks it up within a minute.`, 'team-edit-name')
    return
  }
  if (cms.kind === 'role') {
    const role = /^clear$/i.test(clean) ? '' : clean
    // 'clear' yields an EMPTY role by design — validate the raw input.
    if (!clean || clean.includes('\n') || role.length > TEAM_LIMITS.roleMax) {
      await send(chatId, `⚠️ Role must be 1\u2013${TEAM_LIMITS.roleMax} characters (or <code>clear</code>). Try again, or /cancel.`)
      return
    }
    await updateTeamMember(member.id, { role })
    await done(`✅ Role for <b>${esc(member.name)}</b> updated: <b>${role ? esc(role) : '\u2014'}</b>.`, 'team-edit-role')
    return
  }
  if (cms.kind === 'bio') {
    const bio = /^clear$/i.test(clean) ? '' : clean
    // 'clear' → empty bio is allowed; any real bio must be 3–400 chars.
    if (!clean || (bio.length > 0 && (bio.length < 3 || bio.length > TEAM_LIMITS.bioMax))) {
      await send(chatId, `⚠️ Bio must be 3\u2013${TEAM_LIMITS.bioMax} characters (or <code>clear</code>). Try again, or /cancel.`)
      return
    }
    await updateTeamMember(member.id, { bio })
    await done(`✅ Bio for <b>${esc(member.name)}</b> saved.\n/about picks it up within a minute.`, 'team-edit-bio')
    return
  }
  // cms.kind === 'social'
  let socialUrl: string | null = null
  if (!/^clear$/i.test(clean)) {
    const parsed = parseSocialUrl(clean)
    if (!parsed) {
      await send(chatId, '⚠️ That does not look like a link. Send a URL starting with http:// or https://, or <code>clear</code>.')
      return
    }
    socialUrl = parsed
  }
  await updateTeamMember(member.id, { socialUrl })
  await done(
    `✅ Social link for <b>${esc(member.name)}</b> ${socialUrl ? `updated: ${esc(socialUrl)}` : 'removed'}.`,
    'team-edit-social',
  )
}

async function handleMessage(update: TelegramUpdate, fromId: string, chatId: string, isAdmin: boolean): Promise<void> {
  const text = update.message!.text ?? ''
  const parsedCommand = parseTelegramCommand(text)

  // Commands always win over paste input.
  if (parsedCommand) {
    const { command, args } = parsedCommand
    switch (command) {
      case 'start': {
        if (!isAdmin) return void (await deny(chatId))
        await clearState(fromId)
        await send(chatId, '<b>Merklane admin intake</b>\nWhat do you want to do?', mainMenu)
        return
      }
      case 'help': {
        if (!isAdmin) return void (await deny(chatId))
        await send(chatId, HELP_TEXT, mainMenu)
        return
      }
      case 'cancel': {
        await clearState(fromId)
        await send(chatId, '❌ Cancelled. Nothing was saved.', mainMenu)
        return
      }
      case 'addjob': {
        if (!isAdmin) return void (await deny(chatId))
        const parsed = parseAddJobArgs(args)
        if (!parsed.ok) return void (await send(chatId, `⚠️ ${parsed.message}`))
        const result = await createJobFromSpec(parsed.spec, { source: 'telegram', actor: `tg-admin:${fromId}` })
        await send(
          chatId,
          result.ok
            ? `${result.post.deduped ? '♻️ Already exists' : result.post.status === 'published' ? '✅ Published' : '📝 Draft created'}:\n${esc(result.post.title)}\nid: <code>${result.post.id}</code>`
            : `⚠️ ${result.message}`,
        )
        return
      }
      case 'jobs': {
        if (!isAdmin) return void (await deny(chatId))
        const limit = Number(args.split(/\s+/)[0] ?? 5)
        const jobs = await listRecentJobs(Number.isFinite(limit) ? limit : 5)
        await send(
          chatId,
          jobs.length === 0
            ? 'No postings yet. Add the first with ➕ Add job.'
            : jobs.map((j) => `[${j.status === 'draft' ? '📝' : '🟢'}] <code>${j.id.slice(-6)}</code> · ${esc(j.title)} — ${esc(j.company ?? '?')} (${j.section})`).join('\n'),
        )
        return
      }
      case 'publish': {
        if (!isAdmin) return void (await deny(chatId))
        const res = await publishPostById(args.trim())
        await send(chatId, res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`)
        return
      }
      case 'stats': {
        if (!isAdmin) return void (await deny(chatId))
        const s = await intakeStats()
        await send(
          chatId,
          ['<b>Pipeline</b>', `Published: ${s.published} · Drafts: ${s.drafts}`, `Waitlist: ${s.waitlist}`, `Active premium: ${s.premium}`, `Alerts pending: ${s.pendingAlerts} · failed: ${s.failedAlerts}`].join('\n'),
        )
        return
      }
      case 'mod': {
        if (!isAdmin) return void (await deny(chatId))
        await clearState(fromId)
        const items = await listModerationQueue()
        await send(chatId, moderationQueueText(items), moderationQueueKeyboard(items))
        return
      }
      case 'grant': {
        if (!isAdmin) return void (await deny(chatId))
        const [email, daysRaw] = args.split(/\s+/)
        const days = Number(daysRaw)
        if (!email || !Number.isFinite(days) || days < 1 || days > 3650) {
          await send(chatId, 'Usage: /grant user@email.com 30')
          return
        }
        const res = await grantPremium(email, Math.floor(days))
        if (res.ok) {
          // Phase 4 — every admin action lands in the AuditLog.
          const actor = await resolveTelegramAdminActor(fromId)
          await logAdminAction({
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
            action: 'GRANT_PREMIUM',
            targetId: email.toLowerCase(),
            reason: `Granted ${Math.floor(days)} premium days via /grant`,
          })
        }
        await send(chatId, res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`)
        return
      }
      case 'revoke': {
        if (!isAdmin) return void (await deny(chatId))
        const email = args.trim()
        if (!email) {
          await send(chatId, 'Usage: /revoke user@email.com')
          return
        }
        const res = await revokePremium(email)
        if (res.ok) {
          const actor = await resolveTelegramAdminActor(fromId)
          await logAdminAction({
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
            action: 'REVOKE_PREMIUM',
            targetId: email.toLowerCase(),
            reason: 'Revoked premium via /revoke',
          })
        }
        await send(chatId, res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`)
        return
      }
      default: {
        await send(chatId, 'Unknown command. /help shows the manual.')
      }
    }
    return
  }

  // Non-command text → four possible flows, in priority order:
  //   1. Moderation reason capture (step 'moderation': ❌ Reject flow)
  //   2. CMS text capture (step 'cms': team wizard / field edits)
  //   3. bulk paste    (step 'paste' / 'confirm')
  //   4. hint          (no active state)
  if (!isAdmin) return void (await deny(chatId))
  const state = await getState(fromId)

  if (state?.step === 'moderation' && state.draft.moderation?.kind === 'reject-reason') {
    const target = state.draft.moderation
    const reason = text.trim()
    if (reason.length < REJECT_REASON_MIN || reason.length > REJECT_REASON_MAX) {
      await send(
        chatId,
        `⚠️ The reason must be ${REJECT_REASON_MIN}\u2013${REJECT_REASON_MAX} characters (got ${reason.length}). Try again, or /cancel.`,
      )
      return
    }
    const result = await rejectCampaign(target.campaignId, reason, `tg-admin:${fromId}`)
    await clearState(fromId)
    if (!result.ok) {
      await send(chatId, `⚠️ ${result.message}`, moderationQueueKeyboard(await listModerationQueue()))
      return
    }
    const items = await listModerationQueue()
    await send(
      chatId,
      [
        '❌ <b>Campaign rejected</b>',
        '',
        `Reason stored: <i>${esc(reason)}</i>`,
        'The advertiser sees it in their dashboard and can edit + resubmit.',
        '',
        `Queue after this decision: ${items.length} campaign${items.length === 1 ? '' : 's'}.`,
      ].join('\n'),
      moderationQueueKeyboard(items),
    )
    return
  }

  if (state?.step === 'cms' && state.draft.cms) {
    await handleCmsText(fromId, chatId, state.draft.cms, text)
    return
  }

  if (!state || (state.step !== 'paste' && state.step !== 'confirm')) {
    await send(chatId, 'Send /start to open the admin menu, or ➕ Add job to paste a job.', mainMenu)
    return
  }

  const parsed = parseBulkJobText(text)
  if (!parsed.ok) {
    await send(chatId, `⚠️ ${parsed.message}`)
    return
  }
  await setState(fromId, 'confirm', { spec: parsed.job.spec, guesses: parsed.job.guesses })
  await send(chatId, summaryText(parsed.job.spec, parsed.job.guesses), confirmKeyboard)
}

async function deny(chatId: string): Promise<void> {
  await send(chatId, '⛔ This is the admin intake bot. Your Telegram id is not listed in TELEGRAM_ADMIN_USER_IDS.')
}

// ---------------------------------------------------------------------------
// Photo uploads (CMS avatar / logo flows)
// ---------------------------------------------------------------------------

/**
 * A photo message while step === 'cms' with kind avatar/logo: download the
 * LARGEST size Telegram offers, store it as a data-URL (site logo SiteSetting
 * / TeamMember.avatarUrl) and confirm. Photos outside the flow get a hint
 * instead of being eaten.
 */
async function handlePhoto(update: TelegramUpdate, fromId: string, chatId: string, isAdmin: boolean): Promise<void> {
  if (!isAdmin) return void (await deny(chatId))

  const state = await getState(fromId)
  const cms = state?.step === 'cms' ? state.draft.cms : undefined
  if (!cms || (cms.kind !== 'avatar' && cms.kind !== 'logo')) {
    await send(
      chatId,
      '📷 Got the photo — but nothing is waiting for one. Use 👥 Manage team or 🖼 Change logo first.',
      mainMenu,
    )
    return
  }

  const sizes = update.message?.photo ?? []
  const largest = sizes[sizes.length - 1]
  if (!largest) {
    await send(chatId, '⚠️ No usable photo found in that message. Try sending it as a photo, not a file.')
    return
  }

  const download = await telegramDownloadAsDataUrl(largest.file_id, { token: TOKEN })
  if (!download.ok) {
    await send(chatId, `⚠️ Download failed (${download.error}). Try again, or /cancel.`)
    return
  }

  if (cms.kind === 'logo') {
    await setSiteSetting(SITE_LOGO_KEY, download.dataUrl)
    await clearState(fromId)
    await send(
      chatId,
      `✅ Site logo updated (${(download.bytes / 1024).toFixed(0)} KB). The browser tab icon updates within a minute.`,
      mainMenu,
    )
  } else {
    const member = await getTeamMember(cms.memberId)
    if (!member) {
      await clearState(fromId)
      await send(chatId, '⚠️ That member no longer exists — start again from 👥 Manage team.', mainMenu)
      return
    }
    const updated = await updateTeamMember(member.id, { avatarUrl: download.dataUrl })
    if (!updated) {
      await clearState(fromId)
      await send(chatId, `⚠️ Could not save the avatar for <b>${esc(member.name)}</b> — try again from 👥 Manage team.`, mainMenu)
      return
    }
    await clearState(fromId)
    await send(
      chatId,
      `✅ Avatar for <b>${esc(member.name)}</b> updated (${(download.bytes / 1024).toFixed(0)} KB).`,
      memberMenuKeyboard(member.id),
    )
    await db.ingestionLog
      .create({
        data: {
          source: 'telegram',
          action: 'team-avatar-set',
          actor: `tg-admin:${fromId}`,
          detail: `${member.id} · ${member.name} · ${download.bytes}B`,
        },
      })
      .catch(() => undefined)
    return
  }

  await db.ingestionLog
    .create({
      data: {
        source: 'telegram',
        action: 'cms-logo-set',
        actor: `tg-admin:${fromId}`,
        detail: `logo · ${download.bytes}B`,
      },
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  // 1. Webhook authentication — the secret token Telegram echoes on every call.
  if (!telegramAdminWebhookConfigured()) {
    return jsonError('Admin Telegram webhook is not configured (TELEGRAM_ADMIN_WEBHOOK_SECRET missing).', 503, { code: 'bot_not_configured' })
  }
  const provided = req.headers.get('x-telegram-bot-api-secret-token') ?? ''
  if (provided !== botEnv.TELEGRAM_ADMIN_WEBHOOK_SECRET) {
    return jsonError('Forbidden', 403)
  }

  // 2. Shape check.
  let update: TelegramUpdate
  try {
    update = (await req.json()) as TelegramUpdate
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  const from = update.callback_query?.from ?? update.message?.from
  const chat = update.callback_query?.message?.chat ?? update.message?.chat
  if (!from || !chat) return jsonOk({ ignored: true }) // edits, channel posts, …

  const fromId = String(from.id)
  const chatId = String(chat.id)
  const isAdmin = telegramAdminIds().has(fromId)

  // Per-chat sliding window. 60/min: the team CMS is tap-heavy (each button
  // click AND each typed message is one update — an add-member flow alone is
  // 4-5), so 30/min cut real admins off mid-flow; the webhook secret already
  // blocks forged floods, this only guards runaway loops.
  const rl = rateLimit(`tg-admin-webhook:${chatId}`, 60, 60_000)
  if (!rl.ok) return jsonOk({ ignored: true, reason: 'rate_limited' })

  if (!isAdmin) {
    // Deny politely — still 200, or Telegram would retry a 4xx forever.
    await db.ingestionLog
      .create({ data: { source: 'telegram', action: 'admin-bot-denied', ok: false, actor: `tg:${fromId}` } })
      .catch(() => undefined)
    await deny(chatId).catch(() => undefined)
    return jsonOk({ handled: true, denied: true })
  }

  try {
    if (update.callback_query) {
      await handleCallback(update, fromId, chatId)
    } else if (update.message?.photo?.length) {
      await handlePhoto(update, fromId, chatId, isAdmin)
    } else if (update.message?.text) {
      await handleMessage(update, fromId, chatId, isAdmin)
    } else {
      return jsonOk({ ignored: true })
    }
  } catch (err) {
    console.error('[telegram-admin-webhook] handler error:', err)
    await send(chatId, '⚠️ Something went wrong processing that. Check the server logs — your draft is preserved; /cancel discards it.').catch(() => undefined)
  }

  return jsonOk({ handled: true })
}

/** GET → wiring status (safe to expose: no secrets, just booleans). */
export async function GET() {
  return jsonOk({
    configured: telegramAdminWebhookConfigured(),
    canSend: Boolean(botEnv.TELEGRAM_ADMIN_BOT_TOKEN),
    adminConfigured: telegramAdminIds().size > 0,
    webhook: 'POST /api/webhooks/telegram-admin',
  })
}
