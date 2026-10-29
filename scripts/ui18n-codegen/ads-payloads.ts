/**
 * Aggregator for the ads/adSlot dictionary payloads (all 20 locales).
 * Used by scripts/ui18n-codegen/inject-ads.ts.
 */
import {
  ar, bn, en, es, fa, hi, pt, ru, uk, zh,
} from './ads-payloads-a'
import {
  de, fil, fr, id, ja, ko, th, tr, vi, ur,
} from './ads-payloads-b'

export interface AdsLocalePayload {
  ads: Record<string, string>
  adSlot: Record<string, string>
}

export const ADS_PAYLOADS: Record<string, AdsLocalePayload> = {
  en, ru, uk, hi, zh, fa, ar, bn, es, pt,
  fr, de, ko, ja, id, fil, th, vi, tr, ur,
}
