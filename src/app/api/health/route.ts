import { db } from '@/lib/db'

/** Liveness + DB readiness probe used by the Docker healthcheck. */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`
    return Response.json({ ok: true, status: 'healthy', time: new Date().toISOString() })
  } catch {
    return Response.json({ ok: false, status: 'degraded' }, { status: 503 })
  }
}
