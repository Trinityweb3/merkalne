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
  TEAM_MEMBER_KEYS,
  setSiteSetting,
  siteSettingTeamKey,
  teamMemberLabel,
  type TeamMemberKey,
} from '@/lib/site-settings'

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
  '👥 Manage team — set each member\u2019s bio and avatar photo.',
  '🖼 Change logo — upload the browser tab icon (favicon).',
  'Changes go live within a minute (60 s cache).',
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
    row(cb('👥 Manage team', 'team'), cb('🖼 Change logo', 'logo')),
    row(cb('❓ Help', 'help')),
  ],
}

/** Team CMS root: one button per member (matches about-content.ts). */
function teamMenuKeyboard(): Keyboard {
  return {
    inline_keyboard: [
      ...TEAM_MEMBER_KEYS.map((m) => row(cb(`👤 ${teamMemberLabel(m)}`, `member:${m}`))),
      row(cb('⬅️ Menu', 'menu')),
    ],
  }
}

/** Per-member actions: bio text or avatar photo. */
function memberMenuKeyboard(member: TeamMemberKey): Keyboard {
  return {
    inline_keyboard: [
      row(cb('✏️ Bio', `bio:${member}`), cb('🖼 Avatar', `avatar:${member}`)),
      row(cb('⬅️ Team', 'team'), cb('⬅️ Menu', 'menu')),
    ],
  }
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

type Step = 'paste' | 'confirm' | 'cms'

// NOTE: a type alias (not an interface) — object *type aliases* receive an
// implicit index signature, which is what makes this assignable to Prisma's
// InputJsonObject when the draft is persisted to TelegramAdminState.draft.
type Draft = {
  spec?: JobIntakeSpec
  guesses?: string[]
  /** CMS flow target while step === 'cms' (team bio/avatar, site logo). */
  cms?: { kind: 'bio' | 'avatar' | 'logo'; member?: TeamMemberKey }
}

function esc(s: string): string {
  return tgEscape(s)
}

function sectionLabel(section: string | undefined): string {
  if (!section) return '—'
  const meta = SECTION_META[section as keyof typeof SECTION_META]
  return meta ? meta.title : section
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

  // --- Site CMS: team bios/avatars + site logo ----------------------------
  if (data === 'team') {
    await clearState(fromId)
    await edit(
      chatId,
      messageId,
      '<b>👥 Manage team</b>\nPick a member to edit their bio or avatar.',
      teamMenuKeyboard(),
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
    const member = data.slice(7) as TeamMemberKey
    if (!(TEAM_MEMBER_KEYS as readonly string[]).includes(member)) {
      await telegramAnswerCallbackQuery(cq.id, 'Unknown member.', { token: TOKEN, showAlert: true })
      return
    }
    await clearState(fromId)
    await edit(
      chatId,
      messageId,
      `<b>👤 ${teamMemberLabel(member)}</b>\nWhat do you want to change?`,
      memberMenuKeyboard(member),
    )
    return
  }
  if (data.startsWith('bio:')) {
    const member = data.slice(4) as TeamMemberKey
    if (!(TEAM_MEMBER_KEYS as readonly string[]).includes(member)) {
      await telegramAnswerCallbackQuery(cq.id, 'Unknown member.', { token: TOKEN, showAlert: true })
      return
    }
    await setState(fromId, 'cms', { cms: { kind: 'bio', member } })
    await edit(
      chatId,
      messageId,
      [
        `<b>✏️ Bio for ${teamMemberLabel(member)}</b>`,
        '',
        'Send the new bio as plain text (up to 400 characters).',
        'The current bio is replaced completely.',
        '',
        '<i>Send /cancel to abort.</i>',
      ].join('\n'),
      cancelOnlyKeyboard,
    )
    return
  }
  if (data.startsWith('avatar:')) {
    const member = data.slice(7) as TeamMemberKey
    if (!(TEAM_MEMBER_KEYS as readonly string[]).includes(member)) {
      await telegramAnswerCallbackQuery(cq.id, 'Unknown member.', { token: TOKEN, showAlert: true })
      return
    }
    await setState(fromId, 'cms', { cms: { kind: 'avatar', member } })
    await edit(
      chatId,
      messageId,
      [
        `<b>🖼 Avatar for ${teamMemberLabel(member)}</b>`,
        '',
        'Send the photo now — square works best (rendered at 56px).',
        'The current avatar is replaced completely.',
        '',
        '<i>Send /cancel to abort.</i>',
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
      case 'grant': {
        if (!isAdmin) return void (await deny(chatId))
        const [email, daysRaw] = args.split(/\s+/)
        const days = Number(daysRaw)
        if (!email || !Number.isFinite(days) || days < 1 || days > 3650) {
          await send(chatId, 'Usage: /grant user@email.com 30')
          return
        }
        const res = await grantPremium(email, Math.floor(days))
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
        await send(chatId, res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`)
        return
      }
      default: {
        await send(chatId, 'Unknown command. /help shows the manual.')
      }
    }
    return
  }

  // Non-command text → three possible flows, in priority order:
  //   1. CMS bio capture (step 'cms', kind 'bio')
  //   2. bulk paste    (step 'paste' / 'confirm')
  //   3. hint          (no active state)
  if (!isAdmin) return void (await deny(chatId))
  const state = await getState(fromId)

  if (state?.step === 'cms' && state.draft.cms?.kind === 'bio' && state.draft.cms.member) {
    const member = state.draft.cms.member
    const bio = text.trim()
    if (bio.length < 3 || bio.length > 400) {
      await send(chatId, '⚠️ Bio must be 3–400 characters. Try again, or /cancel.')
      return
    }
    await setSiteSetting(siteSettingTeamKey(member, 'bio'), bio)
    await clearState(fromId)
    await send(
      chatId,
      `✅ Bio for <b>${teamMemberLabel(member)}</b> saved.\n/about picks it up within a minute.`,
      mainMenu,
    )
    await db.ingestionLog
      .create({ data: { source: 'telegram', action: 'cms-bio-set', actor: `tg-admin:${fromId}`, detail: member } })
      .catch(() => undefined)
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
 * LARGEST size Telegram offers, store it as a data-URL SiteSetting and
 * confirm. Photos outside the flow get a hint instead of being eaten.
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
  } else if (cms.member) {
    const member = cms.member
    await setSiteSetting(siteSettingTeamKey(member, 'avatar'), download.dataUrl)
    await clearState(fromId)
    await send(
      chatId,
      `✅ Avatar for <b>${teamMemberLabel(member)}</b> updated (${(download.bytes / 1024).toFixed(0)} KB).`,
      mainMenu,
    )
  } else {
    await clearState(fromId)
    await send(chatId, '⚠️ Lost track of the member — start again from 👥 Manage team.', mainMenu)
    return
  }

  await db.ingestionLog
    .create({
      data: {
        source: 'telegram',
        action: `cms-${cms.kind}-set`,
        actor: `tg-admin:${fromId}`,
        detail: `${cms.kind === 'avatar' ? cms.member : 'logo'} · ${download.bytes}B`,
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

  const rl = rateLimit(`tg-admin-webhook:${chatId}`, 30, 60_000)
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
