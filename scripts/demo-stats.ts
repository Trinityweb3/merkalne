/**
 * DEMO-ONLY: fill the About-page statistics with plausible synthetic data.
 *
 *   bun scripts/demo-stats.ts            # 60 days of visits + 30 days of snapshots
 *   bun scripts/demo-stats.ts --reset    # wipe ALL Visit + DailyStats rows and exit
 *
 * ⚠️ This script DELETES existing Visit/DailyStats rows and inserts FAKE data —
 * it exists so you can preview the /about statistics block before real traffic
 * accumulates (screenshots, investor demos, layout checks). NEVER run it in
 * production: it refuses unless NODE_ENV is non-production and you pass
 * --force... and even then, don't.
 *
 * Real data starts accumulating automatically the moment the site is deployed
 * (POST /api/track beacon) — the worker snapshots it once per day.
 */
import { PrismaClient } from '@prisma/client'
import { computeAndSaveSnapshot, utcMidnight } from '../src/lib/stats/aggregate'
import { visitorFingerprint } from '../src/lib/stats/track'

const prisma = new PrismaClient()

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run in production — this script writes synthetic data.')
  process.exit(1)
}

/** Deterministic PRNG so repeated runs produce the same "history". */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(20261026)

// Weighted page sections — editorial content dominates, like a real jobs site.
const SECTION_PATHS: { path: string; section: string; weight: number }[] = [
  { path: '/', section: 'home', weight: 30 },
  { path: '/intern-junior', section: 'intern-junior', weight: 10 },
  { path: '/mid-senior', section: 'mid-senior', weight: 12 },
  { path: '/opportunities', section: 'opportunities', weight: 9 },
  { path: '/markets', section: 'markets', weight: 7 },
  { path: '/insights', section: 'insights', weight: 6 },
  { path: '/blog', section: 'blog', weight: 5 },
  { path: '/about', section: 'about', weight: 4 },
  { path: '/search', section: 'search', weight: 4 },
  { path: '/premium', section: 'premium', weight: 3 },
  { path: '/auth', section: 'auth', weight: 3 },
  { path: '/contact', section: 'contact', weight: 2 },
]
const TOTAL_WEIGHT = SECTION_PATHS.reduce((s, p) => s + p.weight, 0)

const COUNTRIES: { code: string; weight: number }[] = [
  { code: 'XX', weight: 18 }, // unknown (self-hosted, no geo header) — common, honest
  { code: 'RU', weight: 14 },
  { code: 'UA', weight: 8 },
  { code: 'US', weight: 12 },
  { code: 'DE', weight: 7 },
  { code: 'TR', weight: 6 },
  { code: 'IN', weight: 8 },
  { code: 'BR', weight: 5 },
  { code: 'ID', weight: 5 },
  { code: 'NG', weight: 4 },
  { code: 'FR', weight: 3 },
  { code: 'PL', weight: 3 },
  { code: 'GB', weight: 4 },
  { code: 'KZ', weight: 3 },
]
const COUNTRY_TOTAL = COUNTRIES.reduce((s, c) => s + c.weight, 0)

function pick<T extends { weight: number }>(items: T[], total: number): T {
  let roll = rand() * total
  for (const item of items) {
    roll -= item.weight
    if (roll <= 0) return item
  }
  return items[items.length - 1]
}

async function main() {
  if (process.argv.includes('--reset')) {
    await prisma.visit.deleteMany()
    await prisma.dailyStats.deleteMany()
    console.log('✅ Visit + DailyStats tables wiped (real collection starts fresh).')
    return
  }

  console.log('⚠️  demo-stats: wiping Visit + DailyStats and generating synthetic data…')
  await prisma.visit.deleteMany()
  await prisma.dailyStats.deleteMany()

  const now = Date.now()
  const DAY = 86_400_000
  const DAYS_OF_VISITS = 60
  const SNAPSHOTS_TO_BACKFILL = 30

  let totalVisits = 0
  for (let d = DAYS_OF_VISITS - 1; d >= 0; d--) {
    const dayStart = now - d * DAY
    // Organic growth: ~35 visitors on the oldest day → ~120 on today, with noise.
    const baseVisitors = 35 + ((DAYS_OF_VISITS - d) / DAYS_OF_VISITS) * 85
    const visitors = Math.max(8, Math.round(baseVisitors * (0.75 + rand() * 0.5)))

    for (let v = 0; v < visitors; v++) {
      const visitorId = visitorFingerprint(`demo-ip-${d}-${v}`, `DemoUA/${(v % 7) + 1}.0`)
      // 1–4 pages per visit (returning visitors browse more).
      const pages = 1 + Math.floor(rand() * rand() * 4)
      const usedPaths = new Set<string>()
      for (let p = 0; p < pages; p++) {
        const target = pick(SECTION_PATHS, TOTAL_WEIGHT)
        if (usedPaths.has(target.path)) continue // dedupe mirrors TRACK_DEDUPE_MINUTES
        usedPaths.add(target.path)
        const at = new Date(dayStart + Math.floor(rand() * DAY))
        const country = pick(COUNTRIES, COUNTRY_TOTAL).code
        await prisma.visit.create({
          data: { path: target.path, section: target.section, country, visitorId, createdAt: at },
        })
        totalVisits++
      }
    }
  }
  console.log(`   inserted ${totalVisits} synthetic visits over ${DAYS_OF_VISITS} days`)

  // Backfill one snapshot per fully-elapsed past day (windows end at that
  // day's UTC midnight), exactly like the worker's backfill would.
  const todayMid = utcMidnight(new Date())
  for (let d = SNAPSHOTS_TO_BACKFILL; d >= 1; d--) {
    const day = new Date(todayMid.getTime() - d * DAY)
    await computeAndSaveSnapshot(day, 'demo')
  }
  // And "today, right now" so the page is instantly populated.
  const { data } = await computeAndSaveSnapshot(new Date(), 'demo')

  const latest = data.visitors.map((w) => `${w.window}: ${w.uniqueVisitors}`).join(', ')
  console.log(`   ${SNAPSHOTS_TO_BACKFILL + 1} snapshots written. Today → ${latest}`)
  console.log('✅ done — open /about (hard-refresh; the page reads the latest snapshot).')
  console.log('   Roll back any time:  bun scripts/demo-stats.ts --reset')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
