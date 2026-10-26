/**
 * Minimal Telegram Bot API client (fetch-based — no SDK dependency).
 *
 * Covers exactly what Merklane needs: send text messages (replies, premium job
 * alerts). When no TELEGRAM_BOT_TOKEN is configured, messages are logged to
 * the console instead so local flows remain fully testable — the same
 * "honest dev fallback" convention as the Resend wrapper in src/lib/email.ts.
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

/** The subset of `Update` objects Merklane acts on (private chats). */
export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
}

export interface SendResult {
  delivered: boolean
  /** True when the message was only console-logged (no token configured). */
  devFallback: boolean
  description?: string
}

export async function telegramSendMessage(
  chatId: string | number,
  text: string,
  opts?: { disableWebPreview?: boolean },
): Promise<SendResult> {
  if (!botEnv.TELEGRAM_BOT_TOKEN) {
    console.info(
      `\n[telegram:dev-only] ──────────────────────────────────────────\n` +
        `Chat:   ${chatId}\n${text}\n` +
        `──────────────────────────────────────────────────────────\n`,
    )
    // Dev mode: the console is the transport. Production without a token is a
    // real configuration failure and is reported as undelivered.
    const isDev = process.env.NODE_ENV !== 'production'
    return { delivered: isDev, devFallback: true, description: isDev ? 'console_fallback' : 'token_not_configured' }
  }

  try {
    const res = await fetch(`${API_BASE}/bot${botEnv.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: opts?.disableWebPreview ?? true,
        link_preview_options: { is_disabled: opts?.disableWebPreview ?? true },
      }),
    })

    const payload = (await res.json().catch(() => null)) as
      | { ok: boolean; description?: string }
      | null

    if (!res.ok || !payload?.ok) {
      console.error('[telegram] sendMessage failed:', payload?.description ?? res.status)
      return { delivered: false, devFallback: false, description: payload?.description ?? `HTTP ${res.status}` }
    }
    return { delivered: true, devFallback: false }
  } catch (err) {
    console.error('[telegram] sendMessage network error:', err)
    return { delivered: false, devFallback: false, description: 'network error' }
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
