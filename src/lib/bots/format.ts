/**
 * Alert formatters shared by the dispatch worker and the bot command replies.
 * One job posting → Telegram HTML / Discord embed / Resend HTML, all in the
 * Merklane design language.
 */
import { botEnv } from './config'

export interface AlertPost {
  id: string
  slug: string
  title: string
  company: string | null
  section: string
  location: string | null
  workplace: string | null
  employment: string | null
  level: string | null
  salary: string | null
  stack: string | null
  applyUrl: string | null
  kind: string | null
}

export function postUrl(post: Pick<AlertPost, 'slug'>): string {
  return `${botEnv.APP_URL}/${post.slug}`
}

function tgEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export function formatTelegramJobAlert(post: AlertPost): string {
  const meta = [post.company, post.location, post.employment, post.salary]
    .filter((s): s is string => Boolean(s))
    .map(tgEscape)
    .join(' · ')
  const lines = [
    `🆕 <b>New ${tgEscape(post.section)} posting</b>`,
    `<b>${tgEscape(post.title)}</b>`,
  ]
  if (meta) lines.push(meta)
  if (post.stack) lines.push(`Stack: ${tgEscape(post.stack)}`)
  lines.push('', `<a href="${postUrl(post)}">View &amp; apply on Merklane</a>`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

export function formatDiscordJobAlert(post: AlertPost): {
  content: string
  embed: { title: string; url: string; description: string; fields: { name: string; value: string; inline?: boolean }[] }
} {
  const fields: { name: string; value: string; inline?: boolean }[] = []
  if (post.company) fields.push({ name: 'Company', value: post.company, inline: true })
  if (post.location) fields.push({ name: 'Location', value: post.location, inline: true })
  if (post.employment) fields.push({ name: 'Type', value: post.employment, inline: true })
  if (post.level) fields.push({ name: 'Level', value: post.level, inline: true })
  if (post.salary) fields.push({ name: 'Salary', value: post.salary, inline: true })
  if (post.stack) fields.push({ name: 'Stack', value: post.stack, inline: false })
  if (post.applyUrl) fields.push({ name: 'Apply', value: post.applyUrl, inline: false })

  return {
    content: `🆕 New ${post.section} posting on Merklane`,
    embed: {
      title: post.title,
      url: postUrl(post),
      description: post.kind ? `**${post.kind}** in \`${post.section}\`` : `In \`${post.section}\``,
      fields,
    },
  }
}

// ---------------------------------------------------------------------------
// Email (Resend)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function jobAlertSubject(post: AlertPost): string {
  const prefix = botEnv.NOTIFICATIONS_SUBJECT_PREFIX
  const who = post.company ? ` @ ${post.company}` : ''
  return `${prefix} ${post.title}${who}`.slice(0, 240)
}

export function jobAlertHtml(post: AlertPost): string {
  const rows: string[] = []
  const add = (label: string, value: string) => {
    if (value) rows.push(`<tr><td style="padding:4px 14px 4px 0;color:#6d7480;font-size:13px;white-space:nowrap;">${label}</td><td style="padding:4px 0;color:#f0f1f3;font-size:14px;">${escapeHtml(value)}</td></tr>`)
  }
  add('Section', post.section)
  add('Company', post.company ?? '')
  add('Location', post.location ?? '')
  add('Workplace', post.workplace ?? '')
  add('Employment', post.employment ?? '')
  add('Level', post.level ?? '')
  add('Salary', post.salary ?? '')
  add('Stack', post.stack ?? '')

  const url = postUrl(post)
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0b0d10;font-family:Inter,Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0d10;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0e1013;border:1px solid #2b3039;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:26px 30px;border-bottom:1px solid #2b3039;">
            <span style="font-size:22px;font-weight:750;letter-spacing:-1px;color:#f0f1f3;">Merklane<span style="color:#54c4f5;">.</span></span>
            <span style="float:right;font-size:12px;color:#6d7480;">Premium job alert</span>
          </td>
        </tr>
        <tr>
          <td style="padding:30px;">
            <p style="margin:0 0 6px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#54c4f5;">New ${escapeHtml(post.section)} posting</p>
            <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:#f0f1f3;font-weight:650;">${escapeHtml(post.title)}</h1>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px;">${rows.join('')}</table>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 8px;">
              <tr>
                <td style="background:#54c4f5;border-radius:9px;"><a href="${url}" style="display:inline-block;padding:13px 26px;color:#081219;font-weight:650;font-size:15px;text-decoration:none;">View &amp; apply</a></td>
              </tr>
            </table>
            ${post.applyUrl ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#6d7480;word-break:break-all;">Or apply directly: <a href="${escapeHtml(post.applyUrl)}" style="color:#54c4f5;">${escapeHtml(post.applyUrl)}</a></p>` : ''}
          </td>
        </tr>
        <tr>
          <td style="padding:18px 30px;border-top:1px solid #2b3039;font-size:12px;line-height:1.6;color:#6d7480;">
            You receive this because you have an active Merklane Premium subscription.
            Manage delivery channels any time on <a href="${botEnv.APP_URL}/alerts" style="color:#54c4f5;">the alerts page</a>.
            Verify every opportunity independently — requests for payments, unknown software or wallet permissions can be scams.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export function jobAlertText(post: AlertPost): string {
  const details = [
    `Section: ${post.section}`,
    post.company ? `Company: ${post.company}` : null,
    post.location ? `Location: ${post.location}` : null,
    post.employment ? `Employment: ${post.employment}` : null,
    post.level ? `Level: ${post.level}` : null,
    post.salary ? `Salary: ${post.salary}` : null,
    post.stack ? `Stack: ${post.stack}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return `New ${post.section} posting on Merklane\n\n${post.title}\n${details}\n\nView & apply: ${postUrl(post)}${post.applyUrl ? `\nDirect apply: ${post.applyUrl}` : ''}\n\nManage alerts: ${botEnv.APP_URL}/alerts`
}
