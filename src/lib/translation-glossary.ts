/**
 * Custom translation glossary — protects Web3/crypto jargon from literal
 * machine translation.
 *
 * LibreTranslate (self-hosted, free tier) has no native glossary API, so the
 * protection happens in the transport client (src/lib/translate.ts):
 *
 *    "DeFi TVL hit a record"  →  protect  →  "⟦0⟧ ⟦1⟧ hit a record"
 *                                LibreTranslate (placeholders are opaque)
 *                               →  restore →  "DeFi TVL hit a record"
 *
 * …but with every OTHER word properly translated. If you map a term to a
 * per-language replacement instead (e.g. "Yield farming" → ru:
 * "Фарминг доходности"), the replacement is stitched in at restore time.
 *
 * Two sources, merged (file wins per term):
 *
 *   1. BUILT-IN defaults below — the universally-kept-as-English jargon
 *      (DeFi, TVL, AMM, DAO, …). Always active, compiled into the app, so
 *      the Docker image needs no extra file.
 *
 *   2. A JSON file — TRANSLATION_GLOSSARY_PATH (default:
 *      config/translation-glossary.json relative to the app root). Add terms,
 *      per-language overrides, or "" to UN-protect a built-in term for a
 *      language. Format:
 *
 *        {
 *          "On-chain": "On-chain",
 *          "DeFi": "DeFi",
 *          "Yield farming": { "ru": "Фарминг доходности", "*": "Yield farming" },
 *          "Airdrop": { "ru": "", "*": "Airdrop" }
 *        }
 *
 *      • "term": "…"            → same replacement in EVERY language
 *      • "term": { "ru": "…" }  → per-language; "*" is the fallback for all
 *                                 other languages
 *      • value ""               → do NOT protect for that language (let
 *                                 LibreTranslate translate it naturally)
 *
 * The file is re-read every 60 s (no restart needed after edits). Terms whose
 * resolved value is identical to the source term are restored with the
 * ORIGINAL casing from the text ("on-chain" stays "on-chain", "On-chain"
 * stays "On-chain").
 */
import { env } from './env'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One glossary entry as authored in the JSON file (or the table below). */
export type GlossaryEntry = string | Record<string, string>

/** Parsed shape of the custom glossary file. */
export type GlossaryFile = Record<string, GlossaryEntry>

/** Fully resolved entry: source term → per-language replacement map. */
export interface ResolvedTerm {
  term: string
  /** locale (next-intl or LibreTranslate code) or "*" → replacement ("" = do not protect). */
  map: Record<string, string>
}

// ---------------------------------------------------------------------------
// Built-in defaults — terms the Web3 community keeps in English everywhere.
// Add/remove freely; users can override per term from the JSON file.
// ---------------------------------------------------------------------------

export const DEFAULT_WEB3_GLOSSARY: GlossaryFile = {
  'On-chain': 'On-chain',
  'Onchain': 'Onchain',
  'Off-chain': 'Off-chain',
  Offchain: 'Offchain',
  DeFi: 'DeFi',
  CeFi: 'CeFi',
  TVL: 'TVL',
  AMM: 'AMM',
  DEX: 'DEX',
  CEX: 'CEX',
  DAO: 'DAO',
  NFT: 'NFT',
  NFTs: 'NFTs',
  EVM: 'EVM',
  zkEVM: 'zkEVM',
  'zk-rollup': 'zk-rollup',
  'ZK-rollup': 'ZK-rollup',
  'Layer 1': 'Layer 1',
  'Layer 2': 'Layer 2',
  'L1': 'L1',
  'L2': 'L2',
  Web3: 'Web3',
  'Smart contract': 'Smart contract',
  'Smart contracts': 'Smart contracts',
  'Yield farming': 'Yield farming',
  'Liquid staking': 'Liquid staking',
  'Restaking': 'Restaking',
  Stablecoin: 'Stablecoin',
  Stablecoins: 'Stablecoins',
  Airdrop: 'Airdrop',
  Airdrops: 'Airdrops',
  'Gas fees': 'Gas fees',
  Memecoin: 'Memecoin',
  Memecoins: 'Memecoins',
}

// ---------------------------------------------------------------------------
// Loading + merging (built-in defaults ← custom file, file wins per term)
// ---------------------------------------------------------------------------

const FILE_RELOAD_MS = 60_000

interface GlossaryCache {
  entries: GlossaryFile
  fileLoaded: boolean
  fileWarned: boolean
  fetchedAt: number
}

const cache: GlossaryCache = {
  entries: { ...DEFAULT_WEB3_GLOSSARY },
  fileLoaded: false,
  fileWarned: false,
  fetchedAt: 0,
}

/** Test seam: force the next call to re-read the custom file. */
export function __resetGlossaryCache(): void {
  cache.entries = { ...DEFAULT_WEB3_GLOSSARY }
  cache.fileLoaded = false
  cache.fileWarned = false
  cache.fetchedAt = 0
}

/**
 * Custom glossary file location: explicit env override, else the conventional
 * config/translation-glossary.json next to the app (repo root locally,
 * /app inside the container — mount it there, see docker-compose.yml).
 */
function glossaryPath(): string {
  return env.TRANSLATION_GLOSSARY_PATH || 'config/translation-glossary.json'
}

async function reloadFromFile(): Promise<void> {
  const path = glossaryPath()
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as GlossaryFile
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top level must be a JSON object')
    }
    for (const [term, value] of Object.entries(parsed)) {
      if (term.startsWith('_')) continue // comment keys (_readme, _tip, …)
      if (typeof value !== 'string' && typeof value !== 'object') continue
      if (typeof value === 'object' && value === null) continue
      // "" at the top level un-protects a built-in term everywhere.
      if (value === '') delete cache.entries[term]
      else cache.entries[term] = value
    }
    cache.fileLoaded = true
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException | Error).name === 'Error' && String(err).includes('ENOENT')
    if (!missing && !cache.fileWarned) {
      // A BROKEN glossary file is worth one warning; a missing one is the
      // normal "defaults only" setup and stays silent.
      console.warn(`[glossary] could not load ${path} (${String(err)}) — using built-in defaults`)
      cache.fileWarned = true
    }
  }
}

/**
 * Effective glossary (defaults merged with the custom file), refreshed from
 * disk at most once a minute. Returns entries keyed by source term.
 */
export async function effectiveGlossary(): Promise<GlossaryFile> {
  if (!cache.fileLoaded && Date.now() - cache.fetchedAt > FILE_RELOAD_MS) {
    cache.fetchedAt = Date.now()
    await reloadFromFile()
  }
  return cache.entries
}

/**
 * Resolve the glossary for ONE target locale: source term → the replacement
 * to stitch in ("" = leave unprotected). Lookup order per term:
 * next-intl locale → LibreTranslate language code → "*".
 */
export async function resolvedTermsForLocale(locale: string, ltCode: string): Promise<ResolvedTerm[]> {
  const glossary = await effectiveGlossary()
  const out: ResolvedTerm[] = []
  for (const [term, entry] of Object.entries(glossary)) {
    if (term.startsWith('_')) continue // comment keys (_readme, _tip, …)
    const map: Record<string, string> =
      typeof entry === 'string' ? { '*': entry } : { '*': entry['*'] ?? term, ...entry }
    const replacement = map[locale] ?? map[ltCode] ?? map['*'] ?? ''
    if (replacement === '') continue // explicit un-protect
    out.push({ term, map: { [locale]: replacement } })
  }
  // Longest first so "Yield farming" is protected before "farming"-style
  // overlaps could split it.
  out.sort((a, b) => b.term.length - a.term.length)
  return out
}
