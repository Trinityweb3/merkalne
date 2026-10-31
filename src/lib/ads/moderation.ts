/**
 * Merklane Ads — the Phase 2 moderation lifecycle.
 *
 *   DRAFT ──submit──▶ PENDING ──approve──▶ ACTIVE ⇄ PAUSED
 *                        │                    │
 *                        │                    └─edit (new revision)─▶ PENDING
 *                        ▼
 *                     REJECTED ──edit + submit──▶ PENDING
 *
 * Rules enforced here (the campaign API routes and the Telegram admin bot
 * both call into this module — never duplicate the transitions):
 *
 *   • submit: only DRAFT / REJECTED campaigns; reserves the planned budget
 *     from the wallet the FIRST time (drafts never lock money — Phase 2
 *     change; the reservation itself still goes through the Phase 1
 *     ledger service, so the wallet invariant is untouched)
 *   • approve / reject: only PENDING campaigns; every PENDING creative
 *     revision of the campaign settles with the campaign (latest wins in
 *     the auction either way)
 *   • reject stores the human reason on the creative (moderationNote) so
 *     the advertiser dashboard shows exactly what to fix
 *   • deleted campaigns are untouchable (deletedAt guard on every flip)
 *   • every action lands in IngestionLog for the audit trail
 *
 * The budget/money math itself is NOT redefined here — it stays in
 * wallet.ts / auction.ts exactly as Phase 1 shipped it.
 */
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import type { Prisma, Campaign, Creative } from '@prisma/client'
import { reserveCampaignBudget } from '@/lib/ads/wallet'
import { campaignBudgetStates } from '@/lib/ads/auction'
import { formatMicroUsd, type BillingModel } from '@/lib/ads/money'
import { logAdminAction, resolveTelegramAdminActor } from '@/lib/ads/audit'

/** Min/max characters for a rejection reason (shared by API + bot). */
export const REJECT_REASON_MIN = 3
export const REJECT_REASON_MAX = 500

export type ModerationAction =
  | { ok: true; campaignId: string; status: string }
  | { ok: false; code: 'not_found' | 'not_draft' | 'not_pending' | 'already_in_review' | 'insufficient_wallet' | 'creative_missing'; message: string }

// ---------------------------------------------------------------------------
// Queue (the Telegram admin bot's 🛡 Moderation Queue)
// ---------------------------------------------------------------------------

export interface ModerationQueueItem {
  campaign: Campaign
  creative: Creative | null
  advertiserEmail: string
}

/** All campaigns awaiting review, oldest first (FIFO moderation). */
export async function listModerationQueue(): Promise<ModerationQueueItem[]> {
  const campaigns = await db.campaign.findMany({
    where: { status: 'pending', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 25,
    include: {
      advertiser: { select: { email: true } },
      creatives: { orderBy: { version: 'desc' }, take: 1 },
    },
  })
  return campaigns.map((c) => ({
    campaign: c as Campaign,
    creative: c.creatives[0] ?? null,
    advertiserEmail: c.advertiser.email,
  }))
}

// ---------------------------------------------------------------------------
// Submit for review (wizard Step 5 / the dashboard "Submit for review" button)
// ---------------------------------------------------------------------------

/**
 * DRAFT / REJECTED → PENDING. Runs INSIDE the caller's transaction so the
 * budget reservation (when one is due) is atomic with the status flip.
 *
 * Money: a draft has never reserved anything — the planned budget
 * (campaign.totalBudgetMicroUsd) is reserved from the wallet now, through
 * the Phase 1 ledger service. A rejected campaign may already hold budget
 * from its first submission: only the shortfall (planned − committed) is
 * reserved, so re-submitting never double-locks money.
 */
export async function submitCampaignForReview(
  tx: Prisma.TransactionClient,
  input: { campaignId: string; userId: string },
): Promise<ModerationAction> {
  const campaign = await tx.campaign.findUnique({
    where: { id: input.campaignId },
    include: { creatives: { orderBy: { version: 'desc' }, take: 1 } },
  })
  if (!campaign || campaign.advertiserId !== input.userId || campaign.deletedAt) {
    return { ok: false, code: 'not_found', message: 'Campaign not found' }
  }
  if (campaign.status !== 'draft' && campaign.status !== 'rejected') {
    return {
      ok: false,
      code: campaign.status === 'pending' ? 'already_in_review' : 'not_draft',
      message:
        campaign.status === 'pending'
          ? 'This campaign is already in review.'
          : 'Only draft or rejected campaigns can be submitted for review.',
    }
  }
  const latest = campaign.creatives[0] ?? null
  if (!latest) {
    return { ok: false, code: 'creative_missing', message: 'The campaign has no creative content.' }
  }
  if (latest.moderationStatus === 'pending') {
    return { ok: false, code: 'already_in_review', message: 'This campaign is already in review.' }
  }

  // Budget: reserve the shortfall (drafts: the full planned budget).
  const states = await campaignBudgetStates([campaign.id], new Date(), tx)
  const committed = states.get(campaign.id)?.committedMicroUsd ?? 0
  const planned = Math.max(0, campaign.totalBudgetMicroUsd)
  if (committed < planned) {
    const shortfall = planned - committed
    // Fresh eventId per submit — a rejected campaign can be re-submitted
    // any number of times; the conditional wallet decrement in the ledger
    // service is the overdraw guard (same pattern as "add funds").
    const reserved = await reserveCampaignBudget(tx, {
      userId: input.userId,
      campaignId: campaign.id,
      amountMicroUsd: shortfall,
      eventId: `submit:${campaign.id}:${crypto.randomUUID()}`,
    })
    if (!reserved.ok) {
      return {
        ok: false,
        code: 'insufficient_wallet',
        message: 'Not enough money in your ad wallet — top it up in the Wallet tab first.',
      }
    }
  }

  // Status flips — conditional so a concurrent delete/approve can't race.
  await tx.campaign.updateMany({
    where: { id: campaign.id, status: { in: ['draft', 'rejected'] }, deletedAt: null },
    data: { status: 'pending' },
  })
  await tx.creative.updateMany({
    where: { campaignId: campaign.id, moderationStatus: { in: ['draft', 'rejected'] }, version: latest.version },
    data: { moderationStatus: 'pending', moderationNote: null },
  })

  return { ok: true, campaignId: campaign.id, status: 'pending' }
}

// ---------------------------------------------------------------------------
// Moderation decisions (Telegram admin bot)
// ---------------------------------------------------------------------------

/**
 * Resolve the moderation caller's actor string ("tg-admin:<id>" from the
 * Telegram admin bot, or a platform user id from the future web UI) into
 * the AuditLog actor: the linked platform account when one exists, the
 * honest bot label otherwise.
 */
async function auditActorFor(actor: string): Promise<{ actorId: string; actorLabel: string | null }> {
  if (actor.startsWith('tg-admin:')) {
    return resolveTelegramAdminActor(actor.slice('tg-admin:'.length))
  }
  return { actorId: actor, actorLabel: null }
}

/** PENDING → ACTIVE; every pending creative revision becomes APPROVED. */
export async function approveCampaign(campaignId: string, actor: string): Promise<ModerationAction> {
  const result = await db.$transaction(async (tx) => {
    const flip = await tx.campaign.updateMany({
      where: { id: campaignId, status: 'pending', deletedAt: null },
      data: { status: 'active' },
    })
    if (flip.count !== 1) return null
    await tx.creative.updateMany({
      where: { campaignId, moderationStatus: 'pending' },
      data: { moderationStatus: 'approved', moderationNote: null },
    })
    return await tx.campaign.findUnique({ where: { id: campaignId } })
  })

  if (!result) {
    return {
      ok: false,
      code: 'not_pending',
      message: 'Only campaigns in review can be approved.',
    }
  }

  await db.ingestionLog
    .create({ data: { source: 'telegram', action: 'ads-approve', actor, detail: `${result.id} · ${result.name}` } })
    .catch(() => undefined)

  // Phase 4 — the accountability trail: every approve lands in the AuditLog
  // (best-effort; the IngestionLog row above is the fallback record).
  const auditActor = await auditActorFor(actor)
  await logAdminAction({
    actorId: auditActor.actorId,
    actorLabel: auditActor.actorLabel,
    action: 'APPROVE_CAMPAIGN',
    targetId: campaignId,
    reason: `Approved "${result.name}" — the campaign went live`,
  })
  return { ok: true, campaignId, status: 'active' }
}

/** PENDING → REJECTED; the reason is stored on every pending revision. */
export async function rejectCampaign(
  campaignId: string,
  reason: string,
  actor: string,
): Promise<ModerationAction> {
  const clean = reason.trim()
  if (clean.length < REJECT_REASON_MIN || clean.length > REJECT_REASON_MAX) {
    return {
      ok: false,
      code: 'not_pending',
      message: `The rejection reason must be ${REJECT_REASON_MIN}–${REJECT_REASON_MAX} characters.`,
    }
  }

  const result = await db.$transaction(async (tx) => {
    const flip = await tx.campaign.updateMany({
      where: { id: campaignId, status: 'pending', deletedAt: null },
      data: { status: 'rejected' },
    })
    if (flip.count !== 1) return null
    await tx.creative.updateMany({
      where: { campaignId, moderationStatus: 'pending' },
      data: { moderationStatus: 'rejected', moderationNote: clean },
    })
    return await tx.campaign.findUnique({ where: { id: campaignId } })
  })

  if (!result) {
    return {
      ok: false,
      code: 'not_pending',
      message: 'Only campaigns in review can be rejected.',
    }
  }

  await db.ingestionLog
    .create({ data: { source: 'telegram', action: 'ads-reject', ok: false, actor, detail: `${result.id} · ${result.name}` } })
    .catch(() => undefined)

  // Phase 4 — the accountability trail: the reject REASON the advertiser
  // sees in their dashboard is stored verbatim in the AuditLog, together
  // with who rejected the campaign.
  const auditActor = await auditActorFor(actor)
  await logAdminAction({
    actorId: auditActor.actorId,
    actorLabel: auditActor.actorLabel,
    action: 'REJECT_CAMPAIGN',
    targetId: campaignId,
    reason: clean,
  })
  return { ok: true, campaignId, status: 'rejected' }
}

// ---------------------------------------------------------------------------
// Preview formatting (shared by the Telegram bot)
// ---------------------------------------------------------------------------

/** Compact ad-preview card for the moderator (HTML for Telegram). */
export function moderationPreviewLines(
  esc: (s: string) => string,
  item: { campaign: Campaign; creative: Creative | null; advertiserEmail: string },
): string[] {
  const { campaign: c, creative, advertiserEmail } = item
  const model = c.billingModel as BillingModel
  const bid =
    model === 'cpc'
      ? `${formatMicroUsd(c.bidMicroUsd)} per click`
      : `${formatMicroUsd(c.bidMicroUsd)} per 1000 views`
  const lines = [
    `<b>🛡 Ad review — ${esc(c.name)}</b>`,
    '',
    `Advertiser: ${esc(advertiserEmail)}`,
    `Format: ${c.format === 'banner' ? 'Banner' : 'Text'} · ${model.toUpperCase()} · ${bid}`,
    `Budget: ${formatMicroUsd(c.totalBudgetMicroUsd)}${c.dailyBudgetMicroUsd > 0 ? ` (daily cap ${formatMicroUsd(c.dailyBudgetMicroUsd)})` : ''}`,
  ]
  if (creative) {
    if (c.format === 'banner') {
      lines.push(`Alt text: ${creative.altText ? esc(creative.altText) : '—'}`)
      lines.push(`Image: ${creative.imageUrl ? 'uploaded banner' : '— MISSING'}`)
    } else {
      lines.push(`Title: ${creative.title ? esc(creative.title) : '— MISSING'}`)
      lines.push(`Body: ${creative.body ? esc(creative.body) : '— MISSING'}`)
    }
    if (creative.displayDomain) lines.push(`Display domain: ${esc(creative.displayDomain)}`)
    lines.push(`Destination: ${esc(creative.targetUrl)}`)
    lines.push(`Creative version: v${creative.version}`)
  }
  return lines
}
