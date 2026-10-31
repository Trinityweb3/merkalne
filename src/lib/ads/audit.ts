/**
 * Merklane Phase 4 — the admin AuditLog writer.
 *
 * Every administrative action lands here: campaign moderation decisions from
 * the Telegram admin bot (APPROVE_CAMPAIGN / REJECT_CAMPAIGN — the reject
 * reason the advertiser sees is stored verbatim), balance adjustments
 * (ADJUST_BALANCE — the operator confirming a manual crypto deposit),
 * premium grants/revokes and permission-role changes.
 *
 * Design rules:
 *   • BEST-EFFORT — a failed audit write NEVER blocks the action it
 *     describes (the IngestionLog keeps its own copy of moderation events;
 *     the AuditLog is the accountability view, not a transaction guard).
 *   • actorId is a platform User id whenever the actor is resolvable. The
 *     Telegram admin bot identifies admins by their TELEGRAM id, so the
 *     writer first tries TelegramLink (chatId → user); when the admin has
 *     not linked an account it stores the honest bot label
 *     "tg-admin:<telegram id>" — the column is deliberately not a foreign
 *     key so unlinked bot actors stay auditable.
 *   • reason is free text (REJECT_CAMPAIGN always carries the moderation
 *     reason; balance adjustments carry the credited amount).
 */
import { db } from '@/lib/db'

export const AUDIT_ACTIONS = [
  'APPROVE_CAMPAIGN',
  'REJECT_CAMPAIGN',
  'ADJUST_BALANCE',
  'GRANT_PREMIUM',
  'REVOKE_PREMIUM',
  'SET_ROLE',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditEntry {
  /** Platform User id, or the bot actor label for unlinked Telegram admins. */
  actorId: string
  /** Display identity (email / handle) — optional, for the audit view. */
  actorLabel?: string | null
  action: AuditAction
  /** Campaign id (moderation) or User id (balance / role actions). */
  targetId: string
  /** Free text: the rejection reason, the credited amount, … */
  reason?: string | null
}

/** Append one audit row. Never throws — auditability must not break the action. */
export async function logAdminAction(entry: AuditEntry): Promise<void> {
  if (!entry?.actorId || !entry?.targetId || !entry?.action) return
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorLabel: entry.actorLabel ?? null,
        action: entry.action,
        targetId: entry.targetId,
        reason: entry.reason ?? null,
      },
    })
  } catch {
    // Swallow on purpose (see the header): the moderated action already
    // happened; the IngestionLog row written next to it is the fallback trail.
  }
}

export interface ResolvedActor {
  /** Platform User id when linked; otherwise the bot actor label. */
  actorId: string
  actorLabel: string | null
}

/**
 * Resolve a Telegram admin id to an auditable actor: the linked platform
 * account (TelegramLink.chatId — the admin ran /start on the notifier bot)
 * when it exists, otherwise the honest "tg-admin:<id>" label.
 */
export async function resolveTelegramAdminActor(
  telegramId: string | number,
): Promise<ResolvedActor> {
  const chatId = String(telegramId)
  try {
    const link = await db.telegramLink.findUnique({ where: { chatId } })
    if (link) {
      const user = await db.user.findUnique({
        where: { id: link.userId },
        select: { id: true, email: true },
      })
      if (user) return { actorId: user.id, actorLabel: user.email }
    }
  } catch {
    // fall through to the label form
  }
  return { actorId: `tg-admin:${chatId}`, actorLabel: null }
}
