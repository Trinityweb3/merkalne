/**
 * Minimal Telegram Bot API client (fetch-based — no SDK dependency).
 *
 * Covers exactly what Merklane needs across BOTH bots:
 *   • notifier bot (TELEGRAM_BOT_TOKEN)  — premium alert DMs, account-link
 *     replies, alerts management
 *   • admin intake bot (TELEGRAM_ADMIN_BOT_TOKEN) — job composer wizard:
 *     inline keyboards, callback queries, message editing
 *
 * When a bot's token is not configured, messages are logged to the console
 * instead so local flows remain fully testable — the same "honest dev
 * fallback" convention as the Resend wrapper in src/lib/email.ts.
 */
import { botEnv } from './config'

const API_BASE = 'https://api.telegram.org'

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
}

/** `callback_query` — inline keyboard button presses (admin bot wizard). */
export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  data?: string
  message?: TelegramMessage
}

/** The subset of `Update` objects Merklane acts on (private chats). */
export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

/** Inline keyboard button — either a callback button or a URL button. */
export interface TelegramInlineButton {
  text: string
  callback_data?: string
  url?: string
}

export interface SendOptions {
  disableWebPreview?: boolean
  /** Bot token — defaults to the notifier bot (TELEGRAM_BOT_TOKEN). */
  token?: string
  /** Inline keyboard rows (admin bot wizard). */
  replyMarkup?: { inline_keyboard: TelegramInlineButton[][] }
  /** Replace the keyboard of the message the callback came from. */
  replyToMessageId?: number
}

export interface SendResult {
  delivered: boolean
  /** True when the message was only console-logged (no token configured). */
  devFallback: boolean
  description?: string
  /** The message_id Telegram assigned (null on dev fallback / failure). */
  messageId?: number
}

export async function telegramSendMessage(
  chatId: string | number,
  text: string,
  opts?: SendOptions,
): Promise<SendResult> {
  const token = opts?.token ?? botEnv.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.info(
      `\n[telegram:dev-only] ──────────────────────────────────────────\n` +
        `Chat:   ${chatId}\n${text}\n` +
        (opts?.replyMarkup ? `Buttons: ${JSON.stringify(opts.replyMarkup.inline_keyboard.flat().map((b) => b.text))}\n` : '') +
        `──────────────────────────────────────────────────────────\n`,
    )
    // Dev mode: the console is the transport. Production without a token is a
    // real configuration failure and is reported as undelivered.
    const isDev = process.env.NODE_ENV !== 'production'
    return { delivered: isDev, devFallback: true, description: isDev ? 'console_fallback' : 'token_not_configured' }
  }

  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: opts?.disableWebPreview ?? true,
        link_preview_options: { is_disabled: opts?.disableWebPreview ?? true },
        ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
        ...(opts?.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
      }),
      signal: AbortSignal.timeout(8_000),
    })

    const payload = (await res.json().catch(() => null)) as
      | { ok: boolean; description?: string; result?: { message_id: number } }
      | null

    if (!res.ok || !payload?.ok) {
      console.error('[telegram] sendMessage failed:', payload?.description ?? res.status)
      return { delivered: false, devFallback: false, description: payload?.description ?? `HTTP ${res.status}` }
    }
    return { delivered: true, devFallback: false, messageId: payload.result?.message_id }
  } catch (err) {
    console.error('[telegram] sendMessage network error:', err)
    return { delivered: false, devFallback: false, description: 'network error' }
  }
}

/**
 * Edit a previously sent message (wizard steps replace their own keyboard) —
 * falls back to a fresh sendMessage when the original is too old to edit.
 */
export async function telegramEditMessageText(
  chatId: string | number,
  messageId: number | undefined,
  text: string,
  opts?: SendOptions,
): Promise<SendResult> {
  const token = opts?.token ?? botEnv.TELEGRAM_BOT_TOKEN
  if (!token || !messageId) {
    // Dev fallback / missing id: behave like a normal send.
    return telegramSendMessage(chatId, text, opts)
  }
  try {
    const res = await fetch(`${API_BASE}/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(8_000),
    })
    const payload = (await res.json().catch(() => null)) as { ok: boolean; description?: string } | null
    if (res.ok && payload?.ok) return { delivered: true, devFallback: false, messageId }
    // "message is not modified" is fine; anything else → plain send fallback.
    if (payload?.description?.includes('message is not modified')) {
      return { delivered: true, devFallback: false, messageId }
    }
    return telegramSendMessage(chatId, text, opts)
  } catch {
    return telegramSendMessage(chatId, text, opts)
  }
}

/** Acknowledge a callback query (clears the loading spinner on the button). */
export async function telegramAnswerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  opts?: { showAlert?: boolean; token?: string },
): Promise<void> {
  const token = opts?.token ?? botEnv.TELEGRAM_BOT_TOKEN
  if (!token) return // dev fallback: nothing to acknowledge
  try {
    await fetch(`${API_BASE}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text ? { text: text.slice(0, 190) } : {}),
        ...(opts?.showAlert ? { show_alert: true } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // best effort — a lost ack never breaks the wizard
  }
}

/** Escape untrusted text before it is embedded in HTML parse mode. */
export function tgEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  command: string
  args: string
}

/** Extracts `/command rest of the message` (handles /command@BotName). */
export function parseTelegramCommand(text: string | undefined): ParsedCommand | null {
  if (!text || !text.startsWith('/')) return null
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?\s*([\s\S]*)$/.exec(text.trim())
  if (!match) return null
  return { command: match[1].toLowerCase(), args: match[2].trim() }
}
