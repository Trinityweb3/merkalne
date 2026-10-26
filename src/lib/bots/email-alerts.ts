/**
 * Resend sender for premium job-alert emails.
 *
 * Separate from src/lib/email.ts on purpose: that file is marked `server-only`
 * (Next.js bundler guard) while this module must also run inside the
 * standalone Bun worker. Same honest dev fallback: without RESEND_API_KEY the
 * message is printed to the console so flows stay testable.
 */
import { Resend } from 'resend'
import { botEnv } from './config'
import { jobAlertSubject, jobAlertHtml, jobAlertText, type AlertPost } from './format'

let resend: Resend | null = null

function client(): Resend | null {
  if (!botEnv.RESEND_API_KEY) return null
  if (!resend) resend = new Resend(botEnv.RESEND_API_KEY)
  return resend
}

export interface EmailResult {
  delivered: boolean
  error?: string
}

export async function sendJobAlertEmail(to: string, post: AlertPost): Promise<EmailResult> {
  const subject = jobAlertSubject(post)
  const html = jobAlertHtml(post)
  const text = jobAlertText(post)

  const api = client()
  if (!api) {
    console.info(
      `\n[job-alert:dev-only] ─────────────────────────────────────────\n` +
        `To:      ${to}\nSubject: ${subject}\n${text}\n` +
        `──────────────────────────────────────────────────────────────\n`,
    )
    // In development the console IS the transport — count it as delivered so
    // the NotificationLog ledger and retry logic stay meaningful. In production
    // a missing API key is a real configuration failure.
    const isDev = process.env.NODE_ENV !== 'production'
    return { delivered: isDev, error: isDev ? 'console_fallback' : 'resend_not_configured' }
  }

  const { data, error } = await api.emails.send({
    from: botEnv.EMAIL_FROM,
    to,
    subject,
    html,
    text,
  })

  if (error) {
    console.error('[job-alert] Resend delivery failed:', error)
    return { delivered: false, error: error.message ?? 'resend_error' }
  }
  return { delivered: true, error: data?.id ? undefined : 'no_message_id' }
}
