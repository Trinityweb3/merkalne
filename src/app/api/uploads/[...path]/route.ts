import { stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { handleRouteError, jsonError } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/uploads/[...path] — serve advertiser banner uploads from disk.
 *
 * Why this exists: Next.js only serves files that were in public/ at BUILD
 * time, so banners uploaded at runtime would 404 in the standalone
 * production build. next.config.ts registers a FALLBACK rewrite
 * (/uploads/:path* → /api/uploads/:path*) — rewrites run AFTER the
 * filesystem check, so in dev (file already in public/) the static path
 * wins and this route only answers for files added after the build.
 *
 * Security:
 *   • the path is resolved and re-checked against the uploads root, so
 *     ../ traversal can never escape it
 *   • only the three sniffed upload extensions are served (png/jpg/jpeg/
 *     webp) with their real content types — an uploaded SVG or script can
 *     neither be stored (upload route magic bytes) nor served here
 *   • immutable long cache: the file names are content-unique UUIDs, a
 *     re-upload always produces a new name
 */
const UPLOADS_ROOT = path.join(process.cwd(), 'public', 'uploads')

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  try {
    const { path: segments } = await ctx.params
    if (!segments || segments.length === 0) {
      return jsonError('Not found', 404)
    }

    const resolved = path.resolve(UPLOADS_ROOT, ...segments)
    // Path-traversal guard: the resolved path must stay inside the root.
    if (!resolved.startsWith(UPLOADS_ROOT + path.sep)) {
      return jsonError('Not found', 404)
    }

    const ext = path.extname(resolved).toLowerCase()
    const mime = MIME_BY_EXT[ext]
    if (!mime) return jsonError('Not found', 404) // only upload types are servable

    const info = await stat(resolved).catch(() => null)
    if (!info?.isFile()) return jsonError('Not found', 404)

    const bytes = await readFile(resolved)
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.byteLength),
        // Names are unique UUIDs — the bytes behind a URL never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch (err) {
    return handleRouteError(err)
  }
}
