/**
 * Merklane Ads Phase 3 — the AdEvent delivery log.
 *
 * Three funnel stages are logged SEPARATELY per BudgetReservation:
 *
 *   loaded_impression    server-side, atomically with the reservation
 *                        creation at serve time (src/lib/ads/auction.ts) —
 *                        cannot be forged or missed by the client.
 *   viewable_impression  the validated viewability beacon
 *                        (/api/ads/event) — billable for CPM,
 *                        informational for CPC.
 *   valid_click           the validated click through the signed redirect
 *                        route (/api/ads/click/[token]) — billable for CPC,
 *                        informational for CPM.
 *
 * The UNIQUE (reservationId, eventType) index is the exactly-once guard:
 * a duplicate insert throws P2002, which logAdEvent resolves to
 * { ok: true, duplicate: true } — replaying an event is always a silent
 * no-op for the caller, and NEVER a second charge (the charge is guarded
 * independently by the reservation's conditional status flip and the
 * ledger's unique eventId charge:<reservationId>).
 */
import { db } from '@/lib/db'

export type AdEventType = 'loaded_impression' | 'viewable_impression' | 'valid_click'

export const AD_EVENT_TYPES: readonly AdEventType[] = [
  'loaded_impression',
  'viewable_impression',
  'valid_click',
]

export interface LogAdEventInput {
  campaignId: string
  reservationId: string
  eventType: AdEventType
  /** Placement id, when known (always known at serve; from the token afterwards). */
  slot?: string | null
  /** Truncated visitor UA (antifraud.truncateUserAgent). */
  userAgent?: string | null
  /** Salted hash prefix, never the raw IP (antifraud.hashVisitorIp). */
  ipHash?: string | null
}

export type LogAdEventResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: 'invalid_input' }

/**
 * Append one delivery event. Idempotent by construction: the second insert
 * for the same (reservation, type) resolves to `duplicate: true` instead of
 * throwing, so callers can treat replays as success.
 */
export async function logAdEvent(input: LogAdEventInput): Promise<LogAdEventResult> {
  if (!input.campaignId || !input.reservationId || !AD_EVENT_TYPES.includes(input.eventType)) {
    return { ok: false, reason: 'invalid_input' }
  }
  try {
    await db.adEvent.create({
      data: {
        campaignId: input.campaignId,
        reservationId: input.reservationId,
        eventType: input.eventType,
        slot: input.slot ?? null,
        userAgent: input.userAgent ?? null,
        ipHash: input.ipHash ?? null,
      },
    })
    return { ok: true, duplicate: false }
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code === 'P2002') {
      // The unique (reservationId, eventType) index — a double click or a
      // replayed beacon. Exactly-once: this is a success, not an error.
      return { ok: true, duplicate: true }
    }
    throw err
  }
}
