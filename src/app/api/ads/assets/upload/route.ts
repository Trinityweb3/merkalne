import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { handleRouteError, jsonError, jsonOk } from '@/lib/api'
import { assertMutationSafe } from '@/lib/csrf'
import { rateLimit } from '@/lib/rate-limit'
import { getSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** 1.5 MB hard cap (spec). */
const MAX_BYTES = 1_572_864
/** Uploads land here; the public URL path mirrors it (/uploads/ads/…). */
const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads', 'ads')
const PUBLIC_PREFIX = '/uploads/ads'

/**
 * The ONLY accepted creatives — detected from the file CONTENT (magic
 * bytes), never from the file name or the declared MIME type. SVG, GIF,
 * scripts and everything else are rejected before a byte hits the disk.
 */
type SniffedType = { ext: 'png' | 'jpg' | 'webp'; mime: string }

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff])
const RIFF_SIG = Buffer.from('RIFF', 'ascii')
const WEBP_SIG = Buffer.from('WEBP', 'ascii')

/**
 * Sniff the real file type from the leading bytes:
 *
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   JPEG  FF D8 FF
 *   WebP  "RIFF" … len … "WEBP"   (bytes 0–3 + 8–11)
 *
 * Returns null for anything else — including SVG (which starts with "<" or
 * its compressed variants), HTML, scripts, GIF and every exotic format.
 */
function sniffImageType(buf: Buffer): SniffedType | null {
  if (buf.length < 12) return null
  if (buf.subarray(0, 8).equals(PNG_SIG)) return { ext: 'png', mime: 'image/png' }
  if (buf.subarray(0, 3).equals(JPEG_SIG)) return { ext: 'jpg', mime: 'image/jpeg' }
  if (buf.subarray(0, 4).equals(RIFF_SIG) && buf.subarray(8, 12).equals(WEBP_SIG)) {
    return { ext: 'webp', mime: 'image/webp' }
  }
  return null
}

/**
 * POST /api/ads/assets/upload — the banner creative uploader (Phase 2).
 *
 * multipart/form-data with exactly one `file` field. Security rails:
 *   • session required (advertisers only see this in the wizard)
 *   • CSRF double-submit + origin check (assertMutationSafe)
 *   • 12 uploads / minute / user
 *   • size cap 1.5 MB enforced before anything is stored
 *   • REAL content validation via magic bytes — the extension/MIME the
 *     client sent is ignored entirely, so a renamed .svg/.html/.exe is
 *     rejected no matter what it calls itself; no SVG and no scripts are
 *     ever stored
 *   • the stored file name is a fresh server-generated UUID + the sniffed
 *     extension, so nothing client-controlled ever reaches the disk path
 *
 * The file is saved to public/uploads/ads/ and the returned `url`
 * (/uploads/ads/<uuid>.<ext>) is what the wizard stores in the Creative.
 * In standalone production the file is served by the /api/uploads/[...path]
 * route (registered as a fallback rewrite in next.config.ts); in dev it is
 * served straight from public/.
 */
export async function POST(req: Request) {
  try {
    await assertMutationSafe(req)
    const session = await getSession()
    if (!session) return jsonError('Authentication required', 401)

    const rl = rateLimit(`ads-upload:${session.user.id}`, 12, 60_000)
    if (!rl.ok) return jsonError('Too many uploads — try again in a minute.', 429)

    const contentType = req.headers.get('content-type') ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return jsonError('Send the banner as multipart/form-data with a "file" field.', 400, {
        code: 'not_multipart',
      })
    }

    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return jsonError('Could not read the upload.', 400, { code: 'bad_form' })
    }

    const file = form.get('file')
    if (!(file instanceof File)) {
      return jsonError('Missing "file" field.', 400, { code: 'file_missing' })
    }
    if (file.size <= 0) {
      return jsonError('The file is empty.', 400, { code: 'file_empty' })
    }
    if (file.size > MAX_BYTES) {
      return jsonError('The banner is too large — the limit is 1.5 MB.', 413, { code: 'file_too_large' })
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    const sniffed = sniffImageType(bytes)
    if (!sniffed) {
      return jsonError(
        'Unsupported file — upload a real PNG, JPEG or WebP image (max 1.5 MB). SVG and scripts are not allowed.',
        415,
        { code: 'bad_type' },
      )
    }

    // Server-generated name: nothing client-controlled in the path.
    const name = `${crypto.randomUUID()}.${sniffed.ext}`
    await mkdir(UPLOAD_DIR, { recursive: true })
    await writeFile(path.join(UPLOAD_DIR, name), bytes)

    return jsonOk(
      { url: `${PUBLIC_PREFIX}/${name}`, bytes: file.size, mime: sniffed.mime },
      { status: 201 },
    )
  } catch (err) {
    return handleRouteError(err)
  }
}
