import { db } from '@/lib/db'
import { jsonError, jsonOk } from '@/lib/api'
import { rateLimit } from '@/lib/rate-limit'
import { botEnv, telegramAdminIds, telegramAdminWebhookConfigured } from '@/lib/bots/config'
import {
  parseTelegramCommand,
  tgEscape,
  telegramAnswerCallbackQuery,
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
import { POST_SECTIONS, SECTION_META } from '@/lib/constants'

/**
 * POST /api/webhooks/telegram-admin — the ADMIN INTAKE BOT webhook.
 *
 * This is the second, role-separated Telegram bot (TELEGRAM_ADMIN_BOT_TOKEN —
 * a different bot from @BotFather than the user-facing notifier). The split:
 *
 *   notifier bot (TELEGRAM_BOT_TOKEN)          admin intake bot (this route)
 *   ─ premium alert DMs (worker)               ─ step-by-step job composer
 *   ─ /start account linking                   ─ inline-button wizard
 *   ─ /alerts on|off · /unlink · /whoami       ─ /jobs /publish /stats /grant
 *
 * Wizard (state machine persisted in TelegramAdminState, one draft per admin):
 *   section ▸ title ▸ company ▸ location ▸ workplace ▸ employment ▸ level ▸
 *   salary ▸ stack ▸ applyUrl ▸ body ▸ tags ▸ confirm(✅ publish / 📝 draft)
 *   — every optional step has a ⏭ Skip button, every screen a ❌ Cancel.
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
  '<b>Job composer wizard</b>',
  '/start → ➕ Add job — inline buttons step-by-step',
  '   section ▸ title ▸ company ▸ location ▸ workplace ▸',
  '   employment ▸ level ▸ salary ▸ stack ▸ applyUrl ▸ body ▸ tags',
  '   every optional step has ⏭ Skip · /cancel aborts anywhere',
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
  inline_keyboard: [row(cb('➕ Add job', 'new')), row(cb('📋 Recent jobs', 'jobs'), cb('📊 Stats', 'stats')), row(cb('❓ Help', 'help'))],
}

const sectionKeyboard: Keyboard = {
  inline_keyboard: [
    row(cb('🧑‍🎓 Intern / Junior', 'sec:intern-junior'), cb('🧑‍💻 Mid / Senior', 'sec:mid-senior')),
    row(cb('🚀 Opportunities', 'sec:opportunities'), cb('📈 Markets', 'sec:markets')),
    row(cb('🔎 Insights', 'sec:insights'), cb('✍️ Blog', 'sec:blog')),
    row(cb('❌ Cancel', 'abort')),
  ],
}

const cancelKeyboard: Keyboard = { inline_keyboard: [row(cb('❌ Cancel', 'abort'))] }
const skipKeyboard: Keyboard = { inline_keyboard: [row(cb('⏭ Skip', 'skip'), cb('❌ Cancel', 'abort'))] }

const optionsKeyboard = (prefix: string, options: string[]): Keyboard => ({
  inline_keyboard: [
    ...options.map((o) => row(cb(o, `${prefix}:${o}`))),
    row(cb('⏭ Skip', 'skip'), cb('❌ Cancel', 'abort')),
  ],
})

const confirmKeyboard: Keyboard = {
  inline_keyboard: [row(cb('✅ Publish now', 'pub'), cb('📝 Save draft', 'draft')), row(cb('❌ Cancel', 'abort'))],
}

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

type Step =
  | 'section'
  | 'title'
  | 'company'
  | 'location'
  | 'workplace'
  | 'employment'
  | 'level'
  | 'salary'
  | 'stack'
  | 'applyUrl'
  | 'body'
  | 'tags'
  | 'confirm'

const STEPS: Step[] = [
  'section',
  'title',
  'company',
  'location',
  'workplace',
  'employment',
  'level',
  'salary',
  'stack',
  'applyUrl',
  'body',
  'tags',
  'confirm',
]

// NOTE: a type alias (not an interface) — object *type aliases* receive an
// implicit index signature, which is what makes this assignable to Prisma's
// InputJsonObject when the draft is persisted to TelegramAdminState.draft.
type Draft = {
  section?: string
  title?: string
  company?: string
  location?: string
  workplace?: string
  employment?: string
  level?: string
  salary?: string
  stack?: string
  applyUrl?: string
  body?: string
  tags?: string[]
}

function esc(s: string): string {
  return tgEscape(s)
}

function sectionLabel(draft: Draft): string {
  if (!draft.section) return '—'
  const meta = SECTION_META[draft.section as keyof typeof SECTION_META]
  return meta ? meta.title : draft.section
}

/** Text + keyboard for entering `step` (drives both fresh screens and edits). */
function promptFor(step: Step, draft: Draft): { text: string; keyboard: Keyboard } {
  const progress = (s: Step): number => STEPS.indexOf(s) + 1
  switch (step) {
    case 'section':
      return { text: `<b>New job — step 1/${STEPS.length}</b>\nWhich section?`, keyboard: sectionKeyboard }
    case 'title':
      return {
        text: `<b>Step ${progress(step)}/${STEPS.length} — title</b>\nSend the job title as plain text (4–160 chars).\n<i>Section:</i> ${sectionLabel(draft)}`,
        keyboard: cancelKeyboard,
      }
    case 'company':
      return {
        text: `<b>Step ${progress(step)}/${STEPS.length} — company</b>\nSend the company name, or Skip (editorial posts don't need one).\n<i>Title:</i> ${esc(draft.title ?? '')}`,
        keyboard: skipKeyboard,
      }
    case 'location':
      return { text: `<b>Step ${progress(step)}/${STEPS.length} — location</b>\nSend the location (e.g. "Remote (EU)", "Berlin / Hybrid"), or Skip.`, keyboard: skipKeyboard }
    case 'workplace':
      return { text: `<b>Step ${progress(step)}/${STEPS.length} — workplace</b>\nPick one:`, keyboard: optionsKeyboard('wp', ['Remote', 'Hybrid', 'On-site']) }
    case 'employment':
      return { text: `<b>Step ${progress(step)}/${STEPS.length} — employment</b>\nPick one:`, keyboard: optionsKeyboard('emp', ['Full-time', 'Part-time', 'Internship', 'Contract']) }
    case 'level':
      return { text: `<b>Step ${progress(step)}/${STEPS.length} — level</b>\nPick one:`, keyboard: optionsKeyboard('lvl', ['Junior', 'Mid', 'Senior', 'Lead']) }
    case 'salary':
      return { text: `<b>Step ${progress(step)}/${STEPS.length} — salary</b>\nSend a human-readable range (e.g. "$80k–$120k"), or Skip.`, keyboard: skipKeyboard }
    case 'stack':
      return { text: `<b>Step ${progress(step)}/${STEPS.length} — stack</b>\nSend the specialisation summary (e.g. "Rust / Solana"), or Skip.`, keyboard: skipKeyboard }
    case 'applyUrl':
      return { text: `<b>Step ${progress(step)}/${STEPS.length} — apply URL</b>\nSend the apply/external link (https://…), or Skip.`, keyboard: skipKeyboard }
    case 'body':
      return { text: `<b>Step ${progress(step)}/${STEPS.length} — body</b>\nSend the full description as text (markdown-lite). Skip = auto-generated body.`, keyboard: skipKeyboard }
    case 'tags':
      return { text: `<b>Step ${progress(step)}/${STEPS.length} — tags</b>\nSend comma-separated tags (e.g. "rust,solana,remote"), or Skip.`, keyboard: skipKeyboard }
    case 'confirm':
      return { text: summaryText(draft), keyboard: confirmKeyboard }
  }
}

function nextStep(step: Step): Step | null {
  const i = STEPS.indexOf(step)
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : null
}

function summaryText(draft: Draft): string {
  return [
    '<b>Review &amp; publish</b>',
    '',
    `▸ Section: ${sectionLabel(draft)}`,
    `▸ Title: ${esc(draft.title ?? '—')}`,
    `▸ Company: ${draft.company ? esc(draft.company) : '—'}`,
    `▸ Location: ${draft.location ? esc(draft.location) : '—'}`,
    `▸ Workplace: ${draft.workplace ?? '—'}`,
    `▸ Employment: ${draft.employment ?? '—'}`,
    `▸ Level: ${draft.level ?? '—'}`,
    `▸ Salary: ${draft.salary ? esc(draft.salary) : '—'}`,
    `▸ Stack: ${draft.stack ? esc(draft.stack) : '—'}`,
    `▸ Apply URL: ${draft.applyUrl ? esc(draft.applyUrl) : '—'}`,
    `▸ Tags: ${draft.tags?.length ? esc(draft.tags.join(', ')) : '—'}`,
    `▸ Body: ${draft.body ? `${draft.body.length} chars` : 'auto-generated'}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// State persistence (TelegramAdminState)
// ---------------------------------------------------------------------------

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
// Wizard step processors
// ---------------------------------------------------------------------------

function validateTextStep(step: Step, text: string): { ok: boolean; message?: string } {
  const t = text.trim()
  switch (step) {
    case 'title':
      if (t.length < 4 || t.length > 160) return { ok: false, message: `Title must be 4–160 characters (got ${t.length}). Try again:` }
      return { ok: true }
    case 'company':
      if (t.length > 120) return { ok: false, message: 'Company is too long (max 120). Try again:' }
      return { ok: true }
    case 'location':
      if (t.length > 120) return { ok: false, message: 'Location is too long (max 120). Try again:' }
      return { ok: true }
    case 'salary':
      if (t.length > 80) return { ok: false, message: 'Salary is too long (max 80). Try again:' }
      return { ok: true }
    case 'stack':
      if (t.length > 160) return { ok: false, message: 'Stack is too long (max 160). Try again:' }
      return { ok: true }
    case 'applyUrl': {
      try {
        const u = new URL(t)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol')
        return { ok: true }
      } catch {
        return { ok: false, message: 'That is not a valid http(s) URL. Send the link again, or ⏭ Skip:' }
      }
    }
    case 'body':
      if (t.length > 50_000) return { ok: false, message: 'Body is too long (max 50 000 chars). Send a shorter version:' }
      return { ok: true }
    case 'tags': {
      const tags = t.split(',').map((s) => s.trim()).filter(Boolean)
      if (tags.length > 12) return { ok: false, message: 'Max 12 tags. Send fewer, comma-separated:' }
      if (tags.some((tag) => tag.length > 40)) return { ok: false, message: 'Each tag must be ≤ 40 chars. Try again:' }
      return { ok: true }
    }
    default:
      return { ok: false, message: 'This step uses the buttons below — pick one (or /cancel).' }
  }
}

function applyTextStep(draft: Draft, step: Step, text: string): Draft {
  const t = text.trim()
  const next = { ...draft }
  switch (step) {
    case 'title': next.title = t; break
    case 'company': next.company = t; break
    case 'location': next.location = t; break
    case 'salary': next.salary = t; break
    case 'stack': next.stack = t; break
    case 'applyUrl': next.applyUrl = t; break
    case 'body': next.body = t; break
    case 'tags': next.tags = t.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12); break
  }
  return next
}

async function advance(
  adminUserId: string,
  chatId: string,
  from: Step,
  draft: Draft,
  editMessageId?: number,
): Promise<void> {
  const next = nextStep(from)
  if (!next) return
  await setState(adminUserId, next, draft)
  const prompt = promptFor(next, draft)
  // Button-driven steps swap the keyboard in place (edit); text-input steps
  // send a fresh message so the admin can type immediately.
  if (editMessageId && (next === 'confirm' || next === 'section')) {
    await edit(chatId, editMessageId, prompt.text, prompt.keyboard)
  } else {
    await send(chatId, prompt.text, prompt.keyboard)
  }
}

async function publishDraft(
  adminUserId: string,
  chatId: string,
  draft: Draft,
  publish: boolean,
  fromId: string,
): Promise<void> {
  const spec: JobIntakeSpec = {
    title: draft.title!,
    company: draft.company,
    applyUrl: draft.applyUrl,
    section: draft.section as JobIntakeSpec['section'],
    tags: draft.tags ?? [],
    location: draft.location,
    workplace: draft.workplace,
    employment: draft.employment,
    level: draft.level,
    salary: draft.salary,
    stack: draft.stack,
    body: draft.body,
    publish,
  }
  const result = await createJobFromSpec(spec, { source: 'telegram', actor: `tg-admin:${fromId}` })
  await clearState(adminUserId)

  if (!result.ok) {
    await send(chatId, `⚠️ ${result.message}\nDraft discarded — start again with /start.`)
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
    await setState(fromId, 'section', {})
    await edit(chatId, messageId, promptFor('section', {}).text, sectionKeyboard)
    return
  }
  if (data === 'abort') {
    await clearState(fromId)
    await edit(chatId, messageId, '❌ Cancelled. Nothing was saved.', mainMenu)
    return
  }
  if (data.startsWith('sec:')) {
    const section = data.slice(4)
    if (!(POST_SECTIONS as readonly string[]).includes(section)) {
      await send(chatId, 'Unknown section — start again with /start.')
      return
    }
    await advance(fromId, chatId, 'section', { section }, messageId)
    return
  }
  if (data.startsWith('wp:') || data.startsWith('emp:') || data.startsWith('lvl:')) {
    if (!state || !['workplace', 'employment', 'level'].includes(state.step)) {
      await telegramAnswerCallbackQuery(cq.id, 'Wizard expired — /start to begin again.', { token: TOKEN, showAlert: true })
      return
    }
    const value = data.split(':')[1]
    const draft = { ...state.draft }
    if (state.step === 'workplace') draft.workplace = value
    if (state.step === 'employment') draft.employment = value
    if (state.step === 'level') draft.level = value
    await advance(fromId, chatId, state.step, draft)
    return
  }
  if (data === 'skip') {
    if (!state) {
      await telegramAnswerCallbackQuery(cq.id, 'Wizard expired — /start to begin again.', { token: TOKEN, showAlert: true })
      return
    }
    await advance(fromId, chatId, state.step, state.draft)
    return
  }
  if (data === 'pub' || data === 'draft') {
    if (!state || !state.draft.title || !state.draft.section) {
      await telegramAnswerCallbackQuery(cq.id, 'Wizard expired — /start to begin again.', { token: TOKEN, showAlert: true })
      return
    }
    await publishDraft(fromId, chatId, state.draft, data === 'pub', fromId)
    return
  }
  await telegramAnswerCallbackQuery(cq.id, 'Unknown button — /start', { token: TOKEN, showAlert: true })
}

async function handleMessage(update: TelegramUpdate, fromId: string, chatId: string, isAdmin: boolean): Promise<void> {
  const text = update.message!.text ?? ''
  const parsedCommand = parseTelegramCommand(text)

  // Commands always win over wizard input.
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

  // Non-command text → wizard step input.
  if (!isAdmin) return void (await deny(chatId))
  const state = await getState(fromId)
  if (!state) {
    await send(chatId, 'Send /start to open the admin menu.', mainMenu)
    return
  }

  const check = validateTextStep(state.step, text)
  if (!check.ok) {
    await send(chatId, `⚠️ ${check.message}`)
    return
  }
  const draft = applyTextStep(state.draft, state.step, text)
  await advance(fromId, chatId, state.step, draft)
}

async function deny(chatId: string): Promise<void> {
  await send(chatId, '⛔ This is the admin intake bot. Your Telegram id is not listed in TELEGRAM_ADMIN_USER_IDS.')
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
