/**
 * Merklane Ads Phase 4 — the A/B testing engine.
 *
 * An Experiment compares exactly two APPROVED creatives (Variants A and B)
 * of ONE campaign:
 *
 *   • SINGLE AUCTION WEIGHT — the campaign enters the eligibility loop and
 *     the weighted draw exactly as before (src/lib/ads/auction.ts). The
 *     variant is chosen only AFTER the campaign has WON the impression, so
 *     running an A/B test never doubles the campaign's win probability.
 *   • STABLE 50/50 SPLIT — the arm is sha256(experimentId | visitorId) with
 *     the first byte taken mod 2: deterministic, uniform in expectation and
 *     STABLE per visitor (the same user always sees the same variant, across
 *     sessions and pages). It cannot be influenced from the client: the
 *     visitorId is a salted HMAC of IP + User-Agent minted server-side
 *     (antifraud.visitorStableId).
 *   • ATTRIBUTION — the winning arm is stamped on the serve's
 *     BudgetReservation (variantId) and the first assignment per visitor is
 *     persisted in VariantAssignment (the durable proof; the hash remains
 *     the source of truth, the row is evidence). Clicks and views inherit
 *     the arm through their reservation — the statistics below are a pure
 *     server-side join, nothing client-reported is trusted.
 *   • SIGNIFICANCE — the primary metric (CTR) is compared with a
 *     two-proportion z-test. A winner is ONLY declared when BOTH arms have
 *     ≥ MIN_SAMPLE_PER_ARM impressions, every expected cell of the pooled
 *     table is ≥ 5 (the textbook validity condition) and p ≤ 0.05.
 *     Otherwise the API reports verdict "insufficient" and the UI shows
 *     "Insufficient data" — never a premature winner.
 *
 * Lifecycle: DRAFT (created or paused) → RUNNING → FINISHED.
 *   start:  draft → running (startedAt set on the first start, preserved
 *           across pause/resume so the statistics window stays honest)
 *   pause:  running → draft (the campaign serves its latest approved
 *           creative again; the collected statistics are kept)
 *   finish: draft|running → finished (terminal, endedAt set)
 */
import crypto from 'node:crypto'
import { db } from '@/lib/db'

export const VARIANT_IDS = ['A', 'B'] as const
export type VariantId = (typeof VARIANT_IDS)[number]

/** The only primary metric today (the column allows more without a migration). */
export const PRIMARY_METRICS = ['ctr'] as const
export type PrimaryMetric = (typeof PRIMARY_METRICS)[number]

/** Minimum impressions per arm before a winner may be declared. */
export const MIN_SAMPLE_PER_ARM = 100

/** Significance level — p must be ≤ this for a winner. */
export const SIGNIFICANCE_ALPHA = 0.05

// ---------------------------------------------------------------------------
// Pure assignment + statistics (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * The stable 50/50 arm: sha256("<experimentId>|<visitorId>"), first byte
 * mod 2 → 'A' | 'B'. Deterministic — the same visitor always lands in the
 * same arm of the same experiment; uniform in expectation over visitor ids
 * (each of the 256 first-byte values is equally likely for a random hash).
 */
export function variantForVisitor(experimentId: string, visitorId: string): VariantId {
  const digest = crypto
    .createHash('sha256')
    .update(`${experimentId}|${visitorId}`)
    .digest()
  return digest[0] % 2 === 0 ? 'A' : 'B'
}

/** Error function (Abramowitz & Stegun 7.1.26, |ε| < 1.5e-7) — pure. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

/** Standard normal CDF — pure. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

export interface ZTestResult {
  /** z statistic (0 when both proportions are identical). */
  z: number
  /** Two-tailed p-value. */
  pValue: number
  /** Whether the sample satisfies the validity conditions (see the header). */
  sufficient: boolean
  /** Why the sample is not sufficient yet (human-readable), when it is not. */
  insufficiencyReason: string | null
}

/**
 * Two-proportion z-test (CTR of variant A vs variant B):
 *
 *   z = (pA − pB) / sqrt(p̂(1 − p̂)(1/nA + 1/nB)),  p̂ = (xA + xB)/(nA + nB)
 *   p = 2 · (1 − Φ(|z|))  (two-tailed)
 *
 * sufficient ⟺ nA, nB ≥ MIN_SAMPLE_PER_ARM AND every expected cell of the
 * pooled table ≥ 5 (n·p̂ ≥ 5 and n·(1 − p̂) ≥ 5 for both arms) — the classic
 * z-test validity conditions. Degenerate pooled proportions (p̂ = 0 or 1,
 * making the standard error 0) are treated as insufficient: there is no
 * contrast to test yet.
 */
export function twoProportionZTest(
  successesA: number,
  sampleA: number,
  successesB: number,
  sampleB: number,
): ZTestResult {
  const insufficient = (reason: string): ZTestResult => ({
    z: 0,
    pValue: 1,
    sufficient: false,
    insufficiencyReason: reason,
  })

  if (sampleA < 0 || sampleB < 0 || successesA < 0 || successesB < 0) {
    return insufficient('negative sample')
  }
  if (successesA > sampleA || successesB > sampleB) {
    return insufficient('successes exceed sample')
  }
  if (sampleA < MIN_SAMPLE_PER_ARM || sampleB < MIN_SAMPLE_PER_ARM) {
    return insufficient(
      `each variant needs at least ${MIN_SAMPLE_PER_ARM} impressions (${sampleA} / ${sampleB})`,
    )
  }

  const pA = successesA / sampleA
  const pB = successesB / sampleB
  const pooled = (successesA + successesB) / (sampleA + sampleB)
  if (pooled <= 0 || pooled >= 1) {
    // No contrast exists (all clicks or no clicks at all) — the standard
    // error would be 0; the honest answer is "keep collecting".
    return insufficient('no contrast in the pooled sample yet')
  }

  const expectedCell = (n: number) => Math.min(n * pooled, n * (1 - pooled))
  if (expectedCell(sampleA) < 5 || expectedCell(sampleB) < 5) {
    return insufficient('expected cell counts below 5 — keep collecting')
  }

  const se = Math.sqrt(pooled * (1 - pooled) * (1 / sampleA + 1 / sampleB))
  const z = (pA - pB) / se
  const pValue = 2 * (1 - normalCdf(Math.abs(z)))
  return { z, pValue, sufficient: true, insufficiencyReason: null }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type ExperimentAction =
  | { ok: true; experimentId: string; status: string }
  | {
      ok: false
      code:
        | 'not_found'
        | 'not_owner'
        | 'campaign_not_found'
        | 'creative_invalid'
        | 'already_running'
        | 'not_draft'
        | 'not_running'
        | 'metric_invalid'
        | 'not_approved'
      message: string
    }

/** The campaign states in which an experiment may be created / managed. */
const EXPERIMENT_CAMPAIGN_STATES = ['active', 'paused'] as const

/**
 * Create a DRAFT experiment. Rules (the spec):
 *   • exactly two creative ids, BOTH belonging to this campaign and BOTH
 *     APPROVED (a pending/rejected creative cannot be tested — the auction
 *     would never serve it)
 *   • the campaign must be live (active/paused — i.e. it has passed
 *     moderation) and not deleted
 *   • at most ONE non-finished experiment per campaign
 */
export async function createExperiment(input: {
  userId: string
  campaignId: string
  creativeAId: string
  creativeBId: string
  primaryMetric: PrimaryMetric
}): Promise<ExperimentAction> {
  if (!PRIMARY_METRICS.includes(input.primaryMetric)) {
    return { ok: false, code: 'metric_invalid', message: 'Unsupported primary metric.' }
  }
  const campaign = await db.campaign.findUnique({ where: { id: input.campaignId } })
  if (!campaign || campaign.advertiserId !== input.userId || campaign.deletedAt) {
    return { ok: false, code: 'campaign_not_found', message: 'Campaign not found.' }
  }
  if (!(EXPERIMENT_CAMPAIGN_STATES as readonly string[]).includes(campaign.status)) {
    return {
      ok: false,
      code: 'not_approved',
      message: 'A/B tests need an approved (active or paused) campaign — submit it for review first.',
    }
  }
  if (input.creativeAId === input.creativeBId) {
    return {
      ok: false,
      code: 'creative_invalid',
      message: 'Pick two DIFFERENT creatives — one per variant.',
    }
  }

  const creatives = await db.creative.findMany({
    where: { campaignId: campaign.id, id: { in: [input.creativeAId, input.creativeBId] } },
    select: { id: true, moderationStatus: true },
  })
  const byId = new Map(creatives.map((c) => [c.id, c]))
  for (const [id, label] of [
    [input.creativeAId, 'A'],
    [input.creativeBId, 'B'],
  ] as const) {
    const creative = byId.get(id)
    if (!creative) {
      return {
        ok: false,
        code: 'creative_invalid',
        message: `Variant ${label} is not a creative of this campaign.`,
      }
    }
    if (creative.moderationStatus !== 'approved') {
      return {
        ok: false,
        code: 'creative_invalid',
        message: `Variant ${label} must be an APPROVED creative (current: ${creative.moderationStatus}).`,
      }
    }
  }

  const live = await db.experiment.count({
    where: { campaignId: campaign.id, status: { in: ['draft', 'running'] } },
  })
  if (live > 0) {
    return {
      ok: false,
      code: 'already_running',
      message: 'This campaign already has an experiment — finish it before starting a new one.',
    }
  }

  const created = await db.experiment.create({
    data: {
      campaignId: campaign.id,
      creativeAId: input.creativeAId,
      creativeBId: input.creativeBId,
      primaryMetric: input.primaryMetric,
      status: 'draft',
    },
  })
  return { ok: true, experimentId: created.id, status: created.status }
}

/** DRAFT → RUNNING (startedAt set on the first start, kept across pauses). */
export async function startExperiment(input: {
  userId: string
  experimentId: string
}): Promise<ExperimentAction> {
  const experiment = await ownedExperiment(input.experimentId, input.userId)
  if ('code' in experiment) return experiment
  if (experiment.status !== 'draft') {
    return {
      ok: false,
      code: 'not_draft',
      message: 'Only a draft (created or paused) experiment can be started.',
    }
  }
  const updated = await db.experiment.update({
    where: { id: experiment.id },
    data: { status: 'running', startedAt: experiment.startedAt ?? new Date(), endedAt: null },
  })
  return { ok: true, experimentId: updated.id, status: updated.status }
}

/** RUNNING → DRAFT (paused). startedAt is preserved; the stats are kept. */
export async function pauseExperiment(input: {
  userId: string
  experimentId: string
}): Promise<ExperimentAction> {
  const experiment = await ownedExperiment(input.experimentId, input.userId)
  if ('code' in experiment) return experiment
  if (experiment.status !== 'running') {
    return {
      ok: false,
      code: 'not_running',
      message: 'Only a running experiment can be paused.',
    }
  }
  const updated = await db.experiment.update({
    where: { id: experiment.id },
    data: { status: 'draft' },
  })
  return { ok: true, experimentId: updated.id, status: updated.status }
}

/** DRAFT|RUNNING → FINISHED (terminal). The campaign serves its latest
 *  approved creative again. */
export async function finishExperiment(input: {
  userId: string
  experimentId: string
}): Promise<ExperimentAction> {
  const experiment = await ownedExperiment(input.experimentId, input.userId)
  if ('code' in experiment) return experiment
  if (experiment.status === 'finished') {
    return { ok: false, code: 'not_draft', message: 'This experiment is already finished.' }
  }
  const updated = await db.experiment.update({
    where: { id: experiment.id },
    data: { status: 'finished', endedAt: new Date() },
  })
  return { ok: true, experimentId: updated.id, status: updated.status }
}

async function ownedExperiment(
  experimentId: string,
  userId: string,
): Promise<
    { id: string; status: string; startedAt: Date | null } | { ok: false; code: 'not_found' | 'not_owner'; message: string }
> {
  const experiment = await db.experiment.findUnique({
    where: { id: experimentId },
    include: { campaign: { select: { advertiserId: true } } },
  })
  if (!experiment) return { ok: false, code: 'not_found', message: 'Experiment not found.' }
  if (experiment.campaign.advertiserId !== userId) {
    return { ok: false, code: 'not_owner', message: 'Experiment not found.' }
  }
  return { id: experiment.id, status: experiment.status, startedAt: experiment.startedAt }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface VariantStats {
  variant: VariantId
  creativeId: string
  /** loaded_impression events attributed to this arm. */
  impressions: number
  /** valid_click events attributed to this arm. */
  clicks: number
  /** clicks / impressions; null while impressions = 0. */
  ctr: number | null
  /** Σ amounts of FINALIZED reservations in this arm (µUSD). */
  spentMicroUsd: number
  /** spent / clicks; null while clicks = 0. */
  ecpcMicroUsd: number | null
}

export interface ExperimentStats {
  experimentId: string
  campaignId: string
  status: string
  primaryMetric: PrimaryMetric
  startedAt: string | null
  endedAt: string | null
  variants: [VariantStats, VariantStats]
  /** Visitors assigned to each arm (VariantAssignment rows). */
  assignedVisitors: { A: number; B: number }
  /** The significance verdict — "insufficient" until the z-test passes. */
  verdict:
    | { kind: 'insufficient'; reason: string }
    | { kind: 'winner'; variant: VariantId; pValue: number; z: number }
    | { kind: 'no_difference'; pValue: number; z: number }
}

/**
 * The per-variant statistics of one experiment.
 *
 * Attribution window: events whose BudgetReservation carries a variantId and
 * whose createdAt falls inside [startedAt ?? epoch, endedAt ?? now]. Because
 * at most one experiment per campaign is ever draft/running, windows never
 * overlap and a finished experiment keeps its numbers stable.
 *
 * Two raw queries (one join AdEvent→BudgetReservation, one aggregation over
 * the finalized reservations) — Prisma has no relation from AdEvent to
 * BudgetReservation, and both engines (PostgreSQL / SQLite) accept the same
 * double-quoted SQL.
 */
export async function experimentStats(experiment: {
  id: string
  campaignId: string
  status: string
  primaryMetric: string
  startedAt: Date | null
  endedAt: Date | null
  creativeAId: string
  creativeBId: string
}): Promise<ExperimentStats> {
  const from = experiment.startedAt ?? new Date(0)
  const until = experiment.endedAt ?? new Date()

  // Funnel counts per arm (impressions + clicks).
  const funnelRows = await db.$queryRaw<Array<{ variant: string; type: string; n: number | bigint }>>`
    SELECT r."variantId" AS variant, e."eventType" AS type, COUNT(*) AS n
    FROM "AdEvent" e
    JOIN "BudgetReservation" r ON e."reservationId" = r."id"
    WHERE e."campaignId" = ${experiment.campaignId}
      AND r."variantId" IS NOT NULL
      AND e."eventType" IN ('loaded_impression', 'valid_click')
      AND e."createdAt" >= ${from}
      AND e."createdAt" <= ${until}
    GROUP BY 1, 2
  `
  // Spend per arm: finalized reservations only (a reservation is finalized
  // exactly when it charged — see auction.ts).
  const spendRows = await db.$queryRaw<Array<{ variant: string; n: number | bigint; spent: number | bigint | null }>>`
    SELECT r."variantId" AS variant, COUNT(*) AS n, COALESCE(SUM(r."amountMicroUsd"), 0) AS spent
    FROM "BudgetReservation" r
    WHERE r."campaignId" = ${experiment.campaignId}
      AND r."variantId" IS NOT NULL
      AND r."status" = 'finalized'
      AND r."createdAt" >= ${from}
      AND r."createdAt" <= ${until}
    GROUP BY 1
  `

  const impressions: Record<VariantId, number> = { A: 0, B: 0 }
  const clicks: Record<VariantId, number> = { A: 0, B: 0 }
  for (const row of funnelRows) {
    const variant = row.variant === 'A' ? 'A' : 'B'
    const n = Number(row.n)
    if (row.type === 'loaded_impression') impressions[variant] += n
    if (row.type === 'valid_click') clicks[variant] += n
  }
  const spent: Record<VariantId, number> = { A: 0, B: 0 }
  for (const row of spendRows) {
    const variant = row.variant === 'A' ? 'A' : 'B'
    spent[variant] += Number(row.spent ?? 0)
  }

  const mkVariant = (variant: VariantId, creativeId: string): VariantStats => ({
    variant,
    creativeId,
    impressions: impressions[variant],
    clicks: clicks[variant],
    ctr: impressions[variant] > 0 ? clicks[variant] / impressions[variant] : null,
    spentMicroUsd: spent[variant],
    ecpcMicroUsd: clicks[variant] > 0 ? spent[variant] / clicks[variant] : null,
  })

  const [assignedA, assignedB] = await Promise.all([
    db.variantAssignment.count({ where: { experimentId: experiment.id, variantId: 'A' } }),
    db.variantAssignment.count({ where: { experimentId: experiment.id, variantId: 'B' } }),
  ])

  // The primary metric is CTR — the two-proportion z-test on clicks vs
  // impressions. "Insufficient data" until it passes (never a premature
  // winner, per the spec).
  const test = twoProportionZTest(clicks.A, impressions.A, clicks.B, impressions.B)
  let verdict: ExperimentStats['verdict']
  if (!test.sufficient) {
    verdict = { kind: 'insufficient', reason: test.insufficiencyReason ?? 'insufficient data' }
  } else if (test.pValue <= SIGNIFICANCE_ALPHA) {
    const winner: VariantId = clicks.A / impressions.A >= clicks.B / impressions.B ? 'A' : 'B'
    verdict = { kind: 'winner', variant: winner, pValue: test.pValue, z: test.z }
  } else {
    verdict = { kind: 'no_difference', pValue: test.pValue, z: test.z }
  }

  return {
    experimentId: experiment.id,
    campaignId: experiment.campaignId,
    status: experiment.status,
    primaryMetric: (PRIMARY_METRICS as readonly string[]).includes(experiment.primaryMetric)
      ? (experiment.primaryMetric as PrimaryMetric)
      : 'ctr',
    startedAt: experiment.startedAt?.toISOString() ?? null,
    endedAt: experiment.endedAt?.toISOString() ?? null,
    variants: [
      mkVariant('A', experiment.creativeAId),
      mkVariant('B', experiment.creativeBId),
    ],
    assignedVisitors: { A: assignedA, B: assignedB },
    verdict,
  }
}

/**
 * Record a visitor's arm: the FIRST serve for a (experiment, visitor) pair
 * persists the row; later serves hit the unique index and resolve to a
 * silent no-op (the stable hash computes the same arm anyway — the row is
 * the durable proof, not the source of truth).
 */
export async function recordVariantAssignment(input: {
  experimentId: string
  visitorId: string
  variantId: VariantId
}): Promise<void> {
  try {
    await db.variantAssignment.create({ data: input })
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code === 'P2002') return // already assigned — exactly the guarantee
    throw err
  }
}
