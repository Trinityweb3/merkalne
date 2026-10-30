/**
 * Applies a hand-written migration SQL file to the LOCAL SQLite preview
 * database (db/custom.db / DATABASE_URL=file:…).
 *
 * Why this exists: prisma/migrations target PostgreSQL in production
 * (prisma migrate deploy inside the container entrypoint). The local preview
 * database is SQLite and has no _prisma_migrations bookkeeping — it is kept
 * in sync by `bun run db:push` for plain DDL. Migrations that TRANSFORM DATA
 * (read legacy rows, write new ones, then drop the legacy tables) cannot go
 * through db push, so they are executed from here instead.
 *
 * Engine differences are handled with markers:
 *   -- @pg-only   → statement skipped when running on SQLite
 *   -- @sqlite-only → statement skipped when running on PostgreSQL (unused
 *                     today; the local target is always SQLite)
 *
 * Statement text is split on ";" boundaries after stripping comment lines —
 * the migration files in this repo deliberately contain no semicolons
 * inside string literals, so a textual split is exact.
 *
 * Usage: bun scripts/apply-migration-sql.ts prisma/migrations/<name>/migration.sql
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'

const file = process.argv[2]
if (!file) {
  console.error('usage: bun scripts/apply-migration-sql.ts <migration.sql>')
  process.exit(1)
}

const raw = readFileSync(resolve(process.cwd(), file), 'utf8')

interface Statement {
  sql: string
  pgOnly: boolean
  sqliteOnly: boolean
  comment: string
}
const statements: Statement[] = []
let pgOnly = false
let sqliteOnly = false
let comment = ''
let buffer = ''
for (const line of raw.split('\n')) {
  const trimmed = line.trim()
  if (trimmed.startsWith('--')) {
    if (trimmed.startsWith('-- @pg-only')) {
      pgOnly = true
      comment = trimmed.replace(/^--\s*/, '')
      continue
    }
    if (trimmed.startsWith('-- @sqlite-only')) {
      sqliteOnly = true
      comment = trimmed.replace(/^--\s*/, '')
      continue
    }
    continue // plain comment line
  }
  if (!trimmed) continue
  buffer += line + '\n'
  if (trimmed.endsWith(';')) {
    const sql = buffer.trim()
    buffer = ''
    if (/^(--\s*)?$/.test(sql)) continue
    statements.push({ sql, pgOnly, sqliteOnly, comment })
    pgOnly = false
    sqliteOnly = false
    comment = ''
  }
}
if (buffer.trim()) {
  statements.push({ sql: buffer.trim(), pgOnly, sqliteOnly, comment })
}

const url = process.env.DATABASE_URL ?? 'file:/home/z/my-project/db/custom.db'
const path = url.replace(/^file:/, '')
const db = new Database(path)
db.run('PRAGMA foreign_keys = OFF')

console.log(`[apply-sql] ${file} → ${path} (${statements.length} statements)`)
let applied = 0
let skipped = 0
for (const stmt of statements) {
  if (stmt.pgOnly) {
    skipped++
    console.log(`  [skip] ${stmt.comment || stmt.sql.slice(0, 70)}`)
    continue
  }
  if (stmt.sqliteOnly === true) {
    // (no sqlite-only statements exist today; kept for symmetry)
    skipped++
    continue
  }
  try {
    db.run(stmt.sql)
    applied++
  } catch (err) {
    console.error(`  [FAIL] ${stmt.sql.slice(0, 120)}`)
    console.error(`         ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

// Post-conditions (ads phase 1): legacy tables gone, new tables present.
const expectGone = ['AdCampaign', 'AdImpression']
const expectPresent = ['Wallet', 'LedgerEntry', 'Campaign', 'Creative', 'BudgetReservation']
const tables = db
  .query('SELECT name FROM sqlite_master WHERE type = ?')
  .all('table') as { name: string }[]
const names = new Set(tables.map((t) => t.name))
let ok = true
for (const t of expectGone) {
  if (names.has(t)) {
    console.error(`  [FAIL] legacy table ${t} still present`)
    ok = false
  }
}
for (const t of expectPresent) {
  if (!names.has(t)) {
    console.error(`  [FAIL] new table ${t} missing`)
    ok = false
  }
}
const adBalanceCol = db
  .query('PRAGMA table_info("User")')
  .all() as { name: string }[]
if (adBalanceCol.some((c) => c.name === 'adBalance')) {
  console.error('  [FAIL] User.adBalance still present')
  ok = false
}
const topupCols = db
  .query('PRAGMA table_info("CryptoTopUp")')
  .all() as { name: string }[]
if (topupCols.some((c) => c.name === 'campaignId')) {
  console.error('  [FAIL] CryptoTopUp.campaignId still present')
  ok = false
}

db.close()
if (!ok) process.exit(1)
console.log(`[apply-sql] done — ${applied} applied, ${skipped} skipped (engine-specific)`)
