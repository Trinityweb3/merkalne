import 'server-only'
import { Resend } from 'resend'
import { env } from '@/lib/env'

/**
 * Transactional email via the official Resend SDK.
 *
 * In development (no RESEND_API_KEY) every message is logged to the server
 * console instead, so local flows remain fully testable without an account.
 */

let resend: Resend | null = null

function client(): Resend | null {
  if (!env.RESEND_API_KEY) return null
  if (!resend) resend = new Resend(env.RESEND_API_KEY)
  return resend
}

export interface SendEmailInput {
  to: string
  subject: string
  html: string
  text?: string
}

export async function sendEmail(input: SendEmailInput): Promise<{ delivered: boolean }> {
  const api = client()
  if (!api) {
    console.info(
      `\n[email:dev-only] ────────────────────────────────────────────────\n` +
        `To:      ${input.to}\nSubject: ${input.subject}\n` +
        `${input.text ?? stripHtml(input.html)}\n` +
        `──────────────────────────────────────────────────────────\n`,
    )
    return { delivered: false }
  }

  const { error } = await api.emails.send({
    from: env.EMAIL_FROM,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text ?? stripHtml(input.html),
  })

  if (error) {
    console.error('[email] Resend delivery failed:', error)
    return { delivered: false }
  }
  return { delivered: true }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Branded templates (Merklane design language: #0e1013 card, #54c4f5 accent)
// ---------------------------------------------------------------------------

function layout(title: string, bodyHtml: string, ctaLabel: string, ctaUrl: string, footnote: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#0b0d10;font-family:Inter,Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0d10;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0e1013;border:1px solid #2b3039;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:26px 30px;border-bottom:1px solid #2b3039;">
              <span style="font-size:22px;font-weight:750;letter-spacing:-1px;color:#f0f1f3;">Merklane<span style="color:#54c4f5;">.</span></span>
            </td>
          </tr>
          <tr>
            <td style="padding:30px;">
              <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:#f0f1f3;font-weight:650;">${escapeHtml(title)}</h1>
              <div style="font-size:15px;line-height:1.7;color:#a3a9b5;">${bodyHtml}</div>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;">
                <tr>
                  <td style="background:#54c4f5;border-radius:9px;">
                    <a href="${ctaUrl}" style="display:inline-block;padding:13px 26px;color:#081219;font-weight:650;font-size:15px;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6d7480;word-break:break-all;">${escapeHtml(footnote)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 30px;border-top:1px solid #2b3039;font-size:12px;line-height:1.6;color:#6d7480;">
              You received this email because of activity on your Merklane account.
              Verify every opportunity independently — requests for payments, unknown software or wallet permissions can be scams.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function sendVerificationEmail(to: string, url: string) {
  return sendEmail({
    to,
    subject: 'Verify your email — Merklane',
    html: layout(
      'Confirm your email address',
      '<p>Welcome to Merklane. Confirm this address to activate your account and unlock posting, comments and bookmarks.</p><p>This link expires in 24 hours and can be used once.</p>',
      'Verify email',
      url,
      `Or paste this link into your browser: ${url}`,
    ),
  })
}

export async function sendMagicLinkEmail(to: string, url: string) {
  return sendEmail({
    to,
    subject: 'Your Merklane sign-in link',
    html: layout(
      'Sign in to Merklane',
      '<p>Click the button below to sign in. The link expires in 15 minutes and stops working once used.</p><p>If you did not request it, you can safely ignore this email.</p>',
      'Sign in',
      url,
      `Or paste this link into your browser: ${url}`,
    ),
  })
}

export async function sendPasswordResetEmail(to: string, url: string) {
  return sendEmail({
    to,
    subject: 'Reset your password — Merklane',
    html: layout(
      'Reset your password',
      '<p>We received a request to reset the password for your Merklane account. The link below expires in 60 minutes and can be used once.</p><p>For your security, all active sessions will be signed out after the change.</p>',
      'Choose a new password',
      url,
      `Or paste this link into your browser: ${url}`,
    ),
  })
}

export async function sendWaitlistConfirmation(to: string) {
  const url = `${env.APP_URL}/ads`
  return sendEmail({
    to,
    subject: 'You are on the Merklane Ads waitlist',
    html: layout(
      'You are on the list',
      '<p>Thanks for joining the Merklane Ads waitlist. We will email you the moment the advertising cabinet opens — campaigns, keywords, auction and transparent reporting.</p><p>In the meantime, explore jobs, opportunities and market signals on Merklane.</p>',
      'Explore Merklane',
      url,
      `Manage your interest anytime: ${url}`,
    ),
  })
}
