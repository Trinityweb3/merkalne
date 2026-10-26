/**
 * Premium job-alert dispatch — the engine behind the "Premium Subscriber
 * Notification Bot".
 *
 * Every published post that has never been dispatched (notifiedAt = NULL) is
 * fanned out to every ACTIVE PREMIUM subscriber on each channel they enabled:
 *
 *   • email    → Resend (branded alert template)
 *   • telegram → Bot API DM (user linked their chat via /alerts)
 *   • discord  → the user's personal incoming webhook (encrypted at rest)
 *
 * Idempotency: the (postId, channel, recipient) unique index guarantees a
 * recipient never receives the same posting twice, even across worker
 * restarts or concurrent admin-triggered runs. Failed deliveries are retried
 * up to NOTIFICATION_RETRY_MAX times by retryFailedNotifications().
 *
 * Runtime-agnostic (Next.js admin route + standalone worker).
 */
import { Prisma } from '@prisma/client'
import { db } from '../db'
import { botEnv } from './config'
import { telegramSendMessage } from './telegram'
import { executeDiscordWebhook, maskDiscordWebhook } from './discord'
import { decryptSecret } from './secretbox'
import { sendJobAlertEmail } from './email-alerts'
import { formatTelegramJobAlert, formatDiscordJobAlert, type AlertPost } from './format'

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export interface PremiumRecipient {
  id: string
  email: string
  telegramChatId: string | null
  discordWebhookEnc: string | null
}

/** Users with an active premium plan (plan=premium AND not expired). */
export async function activePremiumUsers(): Promise<PremiumRecipient[]> {
  const users = await db.user.findMany({
    where: {
      plan: 'premium',
      OR: [{ premiumUntil: null }, { premiumUntil: { gt: new Date() } }],
    },
    select: {
      id: true,
      email: true,
      telegramLink: { select: { chatId: true, notificationsEnabled: true } },
      discordWebhook: { select: { urlEnc: true, notificationsEnabled: true } },
    },
  })
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    telegramChatId:
      u.telegramLink?.chatId && u.telegramLink.notificationsEnabled ? u.telegramLink.chatId : null,
    discordWebhookEnc:
      u.discordWebhook?.urlEnc && u.discordWebhook.notificationsEnabled ? u.discordWebhook.urlEnc : null,
  }))
}

// ---------------------------------------------------------------------------
// Delivery primitives
// ---------------------------------------------------------------------------

type Channel = 'email' | 'telegram' | 'discord'

interface QueuedDelivery {
  channel: Channel
  recipient: string
  userId: string
  send: () => Promise<{ delivered: boolean; error?: string }>
}

function buildDeliveries(post: AlertPost, recipients: PremiumRecipient[]): QueuedDelivery[] {
  const queue: QueuedDelivery[] = []

  for (const r of recipients) {
    queue.push({
      channel: 'email',
      recipient: r.email,
      userId: r.id,
      send: () => sendJobAlertEmail(r.email, post),
    })

    if (r.telegramChatId) {
      queue.push({
        channel: 'telegram',
        recipient: r.telegramChatId,
        userId: r.id,
        send: () =>
          telegramSendMessage(r.telegramChatId as string, formatTelegramJobAlert(post)).then((res) => ({
            delivered: res.delivered,
            error: res.delivered ? undefined : res.description,
          })),
      })
    }

    if (r.discordWebhookEnc) {
      // Recipient identifier = masked webhook (stable per webhook id), computed
      // eagerly so the unique index sees a deterministic value.
      let mask = 'discord:invalid'
      try {
        mask = maskDiscordWebhook(decryptSecret(r.discordWebhookEnc))
      } catch {
        // AUTH_SECRET rotated or corrupted row — delivery will fail + log.
      }
      queue.push({
        channel: 'discord',
        recipient: mask,
        userId: r.id,
        send: async () => {
          try {
            const url = decryptSecret(r.discordWebhookEnc as string)
            const { content, embed } = formatDiscordJobAlert(post)
            const res = await executeDiscordWebhook(url, content, embed)
            return { delivered: res.delivered, error: res.error }
          } catch (err) {
            return { delivered: false, error: err instanceof Error ? err.message : 'decrypt_failed' }
          }
        },
      })
    }
  }

  return queue
}

// ---------------------------------------------------------------------------
// Main pass
// ---------------------------------------------------------------------------

export interface DispatchStats {
  postsProcessed: number
  enqueued: number
  sent: number
  failed: number
  skipped: number
}

let dispatchInFlight = false

export async function dispatchPendingPosts(opts?: { maxPosts?: number }): Promise<DispatchStats> {
  const stats: DispatchStats = { postsProcessed: 0, enqueued: 0, sent: 0, failed: 0, skipped: 0 }

  // Single-flight guard: the worker tick and an admin-triggered run must not
  // double-send. The unique index still backstops any residual race.
  if (dispatchInFlight) return stats
  dispatchInFlight = true

  try {
    const now = new Date()
    const posts = await db.post.findMany({
      where: {
        status: 'published',
        notifiedAt: null,
        OR: [{ publishedAt: null }, { publishedAt: { lte: now } }],
      },
      orderBy: [{ publishedAt: 'asc' }],
      take: Math.min(opts?.maxPosts ?? 10, 50),
      select: {
        id: true, slug: true, title: true, company: true, section: true,
        location: true, workplace: true, employment: true, level: true,
        salary: true, stack: true, applyUrl: true, kind: true,
      },
    })
    if (posts.length === 0) return stats

    const recipients = await activePremiumUsers()

    for (const post of posts) {
      const queue = buildDeliveries(post, recipients)

      for (const item of queue) {
        stats.enqueued += 1

        // Enqueue idempotently (unique postId+channel+recipient)
        let row
        try {
          row = await db.notificationLog.create({
            data: { postId: post.id, channel: item.channel, recipient: item.recipient, userId: item.userId, status: 'pending' },
          })
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            stats.skipped += 1 // already delivered (or being retried) to this recipient
            continue
          }
          throw err
        }

        const result = await item.send()
        await db.notificationLog.update({
          where: { id: row.id },
          data: {
            status: result.delivered ? 'sent' : 'failed',
            attempts: { increment: 1 },
            error: result.error ?? null,
            sentAt: result.delivered ? new Date() : null,
          },
        })
        if (result.delivered) {
          stats.sent += 1
        } else {
          stats.failed += 1
        }
      }

      // Mark the post as dispatched regardless of individual failures —
      // retries happen through retryFailedNotifications(), not re-fanout.
      await db.post.update({ where: { id: post.id }, data: { notifiedAt: new Date() } })
      stats.postsProcessed += 1
    }

    return stats
  } finally {
    dispatchInFlight = false
  }
}

// ---------------------------------------------------------------------------
// Retry pass (failed + stale pending rows)
// ---------------------------------------------------------------------------

export async function retryFailedNotifications(): Promise<{ retried: number; sent: number; failed: number }> {
  const cutoff = new Date(Date.now() - 60_000)
  const rows = await db.notificationLog.findMany({
    where: {
      status: { in: ['failed', 'pending'] },
      attempts: { lt: botEnv.NOTIFICATION_RETRY_MAX },
      createdAt: { lt: cutoff },
    },
    include: { post: { select: { id: true, slug: true, title: true, company: true, section: true, location: true, workplace: true, employment: true, level: true, salary: true, stack: true, applyUrl: true, kind: true } } },
    take: 100,
    orderBy: { createdAt: 'asc' },
  })

  let sent = 0
  let failed = 0

  for (const row of rows) {
    let result: { delivered: boolean; error?: string }
    try {
      if (row.channel === 'email') {
        result = await sendJobAlertEmail(row.recipient, row.post)
      } else if (row.channel === 'telegram') {
        const res = await telegramSendMessage(row.recipient, formatTelegramJobAlert(row.post))
        result = { delivered: res.delivered, error: res.delivered ? undefined : res.description }
      } else {
        const link = await db.discordWebhook.findUnique({ where: { userId: row.userId ?? '' } })
        if (!link) {
          result = { delivered: false, error: 'webhook_removed' }
        } else {
          const url = decryptSecret(link.urlEnc)
          const { content, embed } = formatDiscordJobAlert(row.post)
          const res = await executeDiscordWebhook(url, content, embed)
          result = { delivered: res.delivered, error: res.error }
        }
      }
    } catch (err) {
      result = { delivered: false, error: err instanceof Error ? err.message : 'send_error' }
    }

    await db.notificationLog.update({
      where: { id: row.id },
      data: {
        status: result.delivered ? 'sent' : row.attempts + 1 >= botEnv.NOTIFICATION_RETRY_MAX ? 'skipped' : 'failed',
        attempts: { increment: 1 },
        error: result.error ?? null,
        sentAt: result.delivered ? new Date() : null,
      },
    })
    if (result.delivered) {
      sent++
    } else {
      failed++
    }
  }

  return { retried: rows.length, sent, failed }
}
