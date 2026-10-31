/**
 * Aggregator for the Phase-1 ads payloads (parts A + B).
 * Kept as a separate module so inject-ads-phase1.ts has one import, the
 * same pattern as the original ads namespace injection.
 */
import { ADS_PHASE1_A } from './ads-phase1-payloads-a'
import { ADS_PHASE1_B } from './ads-phase1-payloads-b'

export const ADS_PHASE1: Record<string, { adds: Record<string, string>; updates: Record<string, string>; removes: string[] }> = {
  ...ADS_PHASE1_A,
  ...ADS_PHASE1_B,
}
