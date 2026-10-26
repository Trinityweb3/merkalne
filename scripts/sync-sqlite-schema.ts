/**
 * Generates prisma/schema.sqlite.prisma from prisma/schema.prisma.
 *
 * The production target is PostgreSQL (see prisma/schema.prisma and
 * prisma/migrations). For lightweight local previews without a database
 * server the identical model definitions are reused against SQLite — only the
 * datasource block differs, because the schema deliberately avoids
 * provider-specific column types, enums and scalar lists.
 *
 * Usage: bun scripts/sync-sqlite-schema.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(root, 'prisma/schema.prisma')
const targetPath = resolve(root, 'prisma/schema.sqlite.prisma')

let schema = readFileSync(sourcePath, 'utf8')

schema = schema.replace(
  /datasource db \{[^}]*\}/,
  [
    'datasource db {',
    '  provider = "sqlite"',
    '  url      = env("DATABASE_URL")',
    '}',
  ].join('\n'),
)

schema = schema.replace(
  '// Merklane — Prisma schema (PostgreSQL, production)',
  '// Merklane — Prisma schema (SQLite, local preview). AUTO-GENERATED — do not edit.\n// Regenerate with: bun scripts/sync-sqlite-schema.ts',
)

writeFileSync(targetPath, schema)
console.log(`[sync-sqlite-schema] wrote ${targetPath}`)
