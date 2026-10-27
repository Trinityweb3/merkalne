/**
 * Bulk-paste job parser — the engine behind the admin bot's "➕ Add job" flow.
 *
 * The admin pastes the raw job-posting text in ANY format and this module
 * extracts a JobIntakeSpec from it:
 *
 *   1. LABELED lines win outright ("Company: X", "Title: Y", "URL: Z",
 *      "Description: …" captures everything until the next recognized label)
 *   2. unlabeled lines: first one becomes the title ("Role at Company" and
 *      "Role — Company" split automatically), the first http(s) URL becomes
 *      the apply link
 *   3. heuristics fill the gaps: level/workplace/employment keywords
 *      ("senior", "remote", "full-time"…), section inference (junior/intern
 *      → Intern/Junior, testnet/quest/airdrop → Opportunities, price/market
 *      talk → Markets, …), tags from the stack line
 *   4. whatever remains is the body
 *
 * The result is validated against jobIntakeSchema; every heuristic guess is
 * reported in `guesses` so the confirm card can flag it ("Section guessed —
 * tap 🔄 to change").
 *
 * Runtime-agnostic on purpose (imported by the Next.js webhook route AND by
 * the e2e harness): relative imports only.
 */
import { jobIntakeSchema, resolveSectionName, type JobIntakeSpec } from './intake'
import type { PostSection } from '../constants'

// ---------------------------------------------------------------------------
// Label aliases (lowercase, whitespace-collapsed)
// ---------------------------------------------------------------------------

const LABELS: Record<string, string> = {
  // title
  title: 'title',
  'job title': 'title',
  role: 'title',
  position: 'title',
  vacancy: 'title',
  job: 'title',
  // company
  company: 'company',
  employer: 'company',
  organization: 'company',
  organisation: 'company',
  org: 'company',
  firm: 'company',
  project: 'company',
  team: 'company',
  client: 'company',
  // apply url
  url: 'applyUrl',
  link: 'applyUrl',
  apply: 'applyUrl',
  'apply url': 'applyUrl',
  'apply link': 'applyUrl',
  'apply here': 'applyUrl',
  'apply at': 'applyUrl',
  'application url': 'applyUrl',
  'job url': 'applyUrl',
  'link to apply': 'applyUrl',
  // location
  location: 'location',
  place: 'location',
  city: 'location',
  'based in': 'location',
  based: 'location',
  office: 'location',
  // salary
  salary: 'salary',
  comp: 'salary',
  compensation: 'salary',
  pay: 'salary',
  'pay range': 'salary',
  'salary range': 'salary',
  rate: 'salary',
  // employment
  type: 'employment',
  employment: 'employment',
  'employment type': 'employment',
  'job type': 'employment',
  'contract type': 'employment',
  // workplace
  workplace: 'workplace',
  'work mode': 'workplace',
  'working mode': 'workplace',
  mode: 'workplace',
  // level
  level: 'level',
  seniority: 'level',
  experience: 'level',
  'experience level': 'level',
  // stack
  stack: 'stack',
  tech: 'stack',
  'tech stack': 'stack',
  technology: 'stack',
  technologies: 'stack',
  skills: 'stack',
  // tags
  tags: 'tags',
  hashtags: 'tags',
  keywords: 'tags',
  // section
  section: 'section',
  category: 'section',
  board: 'section',
}

/** Labels whose value runs until the NEXT recognized label (multi-line). */
const BODY_LABELS = new Set([
  'description',
  'about',
  'about the role',
  'about the job',
  'details',
  'overview',
  'responsibilities',
  'requirements',
  'body',
  'the role',
  'what you will do',
])

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface ParsedBulkJob {
  spec: JobIntakeSpec
  /** Heuristic decisions worth showing on the confirm card. */
  guesses: string[]
}

export type BulkParseResult = { ok: true; job: ParsedBulkJob } | { ok: false; message: string }

type FieldName =
  | 'title'
  | 'company'
  | 'applyUrl'
  | 'location'
  | 'salary'
  | 'employment'
  | 'workplace'
  | 'level'
  | 'stack'
  | 'tags'
  | 'section'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cleanLine(s: string): string {
  return s.replace(/\u200b/g, '').trim()
}

/** Strip leading bullets/emoji-ish decorations from a pasted line. */
function stripDecorations(s: string): string {
  return cleanLine(s).replace(/^[-•*➤►>·]+\s*/, '')
}

function normalizeLabel(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim()
}

function truncateTitle(s: string): string {
  if (s.length <= 160) return s
  const cut = s.slice(0, 160)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).trimEnd()
}

/** Lines that must never be mistaken for a company name. */
const NOT_COMPANY_RE = /^(remote|hybrid|on[- ]?site)\b/i
const SALARY_ISH_RE = /^[$€£]\s?\d|^\d+\s?k\b|^(full|part)[- ]time/i
const META_ISH_RE = /^(salary|compensation|benefits|requirements|responsibilities|about|description|we offer|what you)\b[:\s]/i

function looksLikeCompany(s: string): boolean {
  if (!s || s.length > 60) return false
  const hadUrl = URL_RE.test(s)
  URL_RE.lastIndex = 0
  if (hadUrl) return false
  if (NOT_COMPANY_RE.test(s) || SALARY_ISH_RE.test(s) || META_ISH_RE.test(s)) return false
  return true
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseBulkJobText(text: string): BulkParseResult {
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n')
  const guesses: string[] = []

  const fields: Partial<Record<FieldName, string>> = {}
  /** Line indexes claimed by labeled extraction / body capture. */
  const consumed = new Set<number>()
  /** Lines captured under a body-ish label (Description: …). */
  const labeledBody: string[] = []

  // --- pass 1: labeled lines -------------------------------------------------
  let capturingBody = false
  for (let i = 0; i < rawLines.length; i++) {
    const line = cleanLine(rawLines[i])
    if (!line) {
      if (capturingBody && labeledBody.length > 0) labeledBody.push('')
      continue
    }
    const m = /^([A-Za-z][A-Za-z0-9 .,&/()\-']{0,30}?)\s*[:：]\s*(.+)$/.exec(line)
    if (m) {
      const label = normalizeLabel(m[1])
      const value = cleanLine(m[2])
      if (BODY_LABELS.has(label)) {
        consumed.add(i)
        capturingBody = true
        if (value) labeledBody.push(value)
        continue
      }
      const target = LABELS[label] as FieldName | undefined
      if (target && value && !fields[target]) {
        fields[target] = value
        consumed.add(i)
        capturingBody = false
        continue
      }
    }
    if (capturingBody) labeledBody.push(line)
  }

  // --- pass 2: apply URL from anywhere unconsumed -----------------------------
  if (!fields.applyUrl) {
    outer: for (let i = 0; i < rawLines.length; i++) {
      if (consumed.has(i)) continue
      const line = cleanLine(rawLines[i])
      const url = line.match(URL_RE)
      if (url) {
        fields.applyUrl = url[0].replace(/[.,;:)]+$/, '')
        // Consume the line only when it is nothing but the URL.
        if (cleanLine(line).replace(/[.,;:)]+$/, '') === fields.applyUrl) consumed.add(i)
        break outer
      }
    }
  }

  /** Unconsumed, decoration-stripped lines in document order. */
  const remaining = rawLines
    .map((l, i) => ({ line: stripDecorations(l), i }))
    .filter(({ line, i }) => line.length > 0 && !consumed.has(i))

  // --- pass 3: title + company from unlabeled lines ---------------------------
  if (!fields.title && remaining.length > 0) {
    let candidate = remaining[0].line
    if (!fields.company) {
      const split = candidate.split(/\s+(?:at|@)\s+|\s+[—–]\s+|\s+\|\s+/i)
      if (split.length === 2 && split[0].trim().length >= 4 && looksLikeCompany(split[1].trim())) {
        candidate = split[0].trim()
        fields.company = split[1].trim()
      }
    }
    fields.title = truncateTitle(candidate)
    consumed.add(remaining[0].i)
  }

  if (!fields.company) {
    const maybe = remaining.find(({ line, i }) => !consumed.has(i) && looksLikeCompany(line))
    if (maybe) {
      fields.company = maybe.line
      consumed.add(maybe.i)
    }
  }

  // --- pass 4: heuristics (workplace / employment / level / location) ----------
  const haystack = [fields.title, fields.company, ...rawLines.filter((_, i) => !consumed.has(i))]
    .filter(Boolean)
    .join('\n')

  if (!fields.workplace) {
    if (/\bremote\b/i.test(haystack)) fields.workplace = 'Remote'
    else if (/\bhybrid\b/i.test(haystack)) fields.workplace = 'Hybrid'
    else if (/\bon[- ]?site\b/i.test(haystack)) fields.workplace = 'On-site'
    if (fields.workplace) guesses.push(`Workplace guessed: ${fields.workplace}`)
  }
  if (!fields.employment) {
    if (/\bfull[- ]time\b/i.test(haystack)) fields.employment = 'Full-time'
    else if (/\bpart[- ]time\b/i.test(haystack)) fields.employment = 'Part-time'
    else if (/\binternship\b/i.test(haystack)) fields.employment = 'Internship'
    else if (/\bcontract\b/i.test(haystack)) fields.employment = 'Contract'
    if (fields.employment) guesses.push(`Employment guessed: ${fields.employment}`)
  }
  if (!fields.level) {
    if (/\b(intern|internship|junior|jr\.?|entry[- ]level|graduate|trainee)\b/i.test(haystack)) fields.level = 'Junior'
    else if (/\b(senior|sr\.?|lead|principal|staff|head of)\b/i.test(haystack)) fields.level = 'Senior'
    else if (/\bmid\b/i.test(haystack)) fields.level = 'Mid'
    if (fields.level) guesses.push(`Level guessed: ${fields.level}`)
  }
  if (!fields.location) {
    // "Remote (EU)" / "Remote — Berlin" style lines
    const m = haystack.match(/\bremote\s*[-–(]\s*([^)\n]{2,40})\)?/i)
    if (m) {
      fields.location = cleanLine(m[1])
      if (!fields.workplace) fields.workplace = 'Remote'
    }
  }

  // --- pass 5: section (explicit label resolved; else inferred) -----------------
  let section: PostSection | undefined
  if (fields.section) {
    section = resolveSectionName(fields.section)
    if (!section) guesses.push(`Section "${fields.section}" is unknown — inferred instead`)
  }
  if (!section) {
    section = inferSection(haystack, fields) as PostSection
    guesses.push('Section guessed — tap 🔄 Section to change')
  }

  // --- pass 6: tags --------------------------------------------------------------
  let tags: string[] = []
  if (fields.tags) {
    tags = fields.tags.split(/[,;|]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
  } else if (fields.stack) {
    tags = fields.stack
      .split(/[,;/|]/)
      .map((t) => t.replace(/\s*\(.*?\)\s*/g, '').trim().toLowerCase())
      .filter((t) => t && t.length <= 40)
    if (tags.length > 0) guesses.push(`Tags derived from stack: ${tags.join(', ')}`)
  }
  tags = [...new Set(tags)].slice(0, 12)

  // --- pass 7: body = labeled capture + leftover unconsumed lines ----------------
  const leftover = rawLines
    .map((l, i) => ({ line: stripDecorations(l), i }))
    .filter(({ line, i }) => line.length > 0 && !consumed.has(i))
    .map(({ line }) => line)
  const body = [...labeledBody, ...leftover].join('\n').replace(/\n{3,}/g, '\n\n').trim()

  // --- validate -------------------------------------------------------------------
  if (!fields.title || fields.title.trim().length < 4) {
    return {
      ok: false,
      message:
        'Could not find a title (first line, or "Title: …"). Send the paste again with the job title on the first line.',
    }
  }

  const specDraft = {
    title: fields.title.trim(),
    company: fields.company?.trim() || undefined,
    applyUrl: fields.applyUrl?.trim() || undefined,
    section,
    tags,
    location: fields.location?.trim() || undefined,
    workplace: fields.workplace?.trim() || undefined,
    employment: fields.employment?.trim() || undefined,
    level: fields.level?.trim() || undefined,
    salary: fields.salary?.trim() || undefined,
    stack: fields.stack?.trim() || undefined,
    body: body || undefined,
    publish: true,
  }

  const parsed = jobIntakeSchema.safeParse(specDraft)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      message: `Parsed fields failed validation: ${issue.path.join('.') || 'spec'}: ${issue.message}. Fix the paste and send it again.`,
    }
  }

  return { ok: true, job: { spec: parsed.data, guesses } }
}

// ---------------------------------------------------------------------------
// Section inference
// ---------------------------------------------------------------------------

function inferSection(text: string, fields: Partial<Record<FieldName, string | undefined>>): PostSection {
  const t = text.toLowerCase()

  const jobish = Boolean(fields.company || fields.applyUrl || fields.employment || fields.level)
  const juniorish = /\b(intern|internship|junior|entry[- ]level|graduate|trainee)\b/.test(t)

  if (juniorish && (jobish || /\b(role|position|vacancy|job|hiring|apply)\b/.test(t))) return 'intern-junior'

  if (/\b(testnet|quest|airdrop|bounty|giveaway|campaign|ambassador|points program|incentive)\b/.test(t)) {
    return 'opportunities'
  }
  if (/\b(price|market|markets|rally|bitcoin|ethereum|btc|eth|altcoin|token unlock|weekly recap|fed|cpi)\b/.test(t)) {
    return 'markets'
  }
  if (/\b(analysis|deep dive|research|report|explained|guide|tutorial|how to|case study)\b/.test(t)) {
    return 'insights'
  }
  if (/\b(we are|we're|announcing|announcement|roadmap|behind the scenes|merklane)\b/.test(t)) {
    return 'blog'
  }
  // Default: the admin bot exists to post jobs — anything unrecognizable is
  // most likely a job paste that just lacks labels.
  return 'mid-senior'
}
