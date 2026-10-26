/**
 * Merklane background worker — the always-on process behind:
 *
 *   1. Job ingestion   — pulls external job feeds (INGEST_FEED_URLS, e.g. the
 *                        Remotive public API) into the database as drafts
 *                        (or published when AUTO_PUBLISH_INGESTED_JOBS=true)
 *   2. Premium alerts  — fans out every newly published posting to active
 *                        premium subscribers via email (Resend), Telegram DMs
 *                        and personal Discord webhooks, with retries
 *   3. Daily stats     — computes the About-page statistics snapshot once per
 *                        UTC day (STATS_SNAPSHOT_UTC_HOUR) with backfill for
 *                        missed days
 *
 * Runs standalone with Bun (no Next.js runtime needed):
 *   bun worker/worker.ts            (local / docker compose "worker" service)
 *
 * Liveness: touches WORKER_HEARTBEAT_FILE every 15 s — the docker-compose
 * healthcheck fails when that file goes stale (e.g. a hung event loop).
 *
 * All business logic lives in src/lib/bots/* and src/lib/stats/* so the
 * webhook routes and this worker share exactly one implementation.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { botEnv, ingestFeedUrls } from '../src/lib/bots/config'
import { ingestFeed } from '../src/lib/bots/feeds'
import { dispatchPendingPosts, retryFailedNotifications } from '../src/lib/bots/dispatch'
import { runStatsTick } from '../src/lib/stats/aggregate'
import { statsEnv } from '../src/lib/stats/config'

const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/worker-heartbeat'

function log(scope: string, message: string) {
  const line = `[worker:${scope}] ${new Date().toISOString()} ${message}`
  console.log(line)
  try {
    appendFileSync('/tmp/worker.log', `${line}\n`)
  } catch {
    // /tmp not writable (read-only fs) — console is enough
  }
}

function touchHeartbeat() {
  try {
    writeFileSync(HEARTBEAT_FILE, String(Date.now()))
  } catch {
    // heartbeat is best-effort
  }
}

// ---------------------------------------------------------------------------
// Tick implementations
// ---------------------------------------------------------------------------

async function tickIngest(): Promise<void> {
  const feeds = ingestFeedUrls()
  if (feeds.length === 0) return // feed ingestion disabled — nothing to do

  for (const url of feeds) {
    try {
      const stats = await ingestFeed(url, botEnv.AUTO_PUBLISH_INGESTED_JOBS)
      if (stats.error) {
        log('ingest', `feed failed: ${url} — ${stats.error}`)
      } else {
        log('ingest', `${url} → fetched ${stats.fetched}, created ${stats.created}, dup ${stats.duplicates}, invalid ${stats.invalid}${stats.published ? ' (auto-published)' : ' (drafts)'}`)
      }
    } catch (err) {
      log('ingest', `unexpected error for ${url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function tickDispatch(): Promise<void> {
  try {
    const dispatch = await dispatchPendingPosts()
    if (dispatch.postsProcessed > 0 || dispatch.sent > 0 || dispatch.failed > 0) {
      log(
        'dispatch',
        `posts ${dispatch.postsProcessed} · enqueued ${dispatch.enqueued} · sent ${dispatch.sent} · failed ${dispatch.failed} · skipped ${dispatch.skipped}`,
      )
    }
    const retry = await retryFailedNotifications()
    if (retry.retried > 0) {
      log('dispatch', `retried ${retry.retried} → sent ${retry.sent}, failed ${retry.failed}`)
    }
  } catch (err) {
    log('dispatch', `error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function tickStats(): Promise<void> {
  try {
    const { computed } = await runStatsTick(new Date())
    if (computed.length > 0) {
      log('stats', `snapshot(s) computed for: ${computed.join(', ')}`)
    }
  } catch (err) {
    log('stats', `error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  if (!botEnv.WORKER_ENABLED) {
    console.log('[worker] WORKER_ENABLED=false — exiting without scheduling.')
    return
  }

  const feeds = ingestFeedUrls()
  console.log(
    [
      '╭──────────────────────────────────────────────────────╮',
      '│ Merklane worker — ingestion + alerts + daily stats    │',
      '╰──────────────────────────────────────────────────────╯',
      `  ingest   : every ${botEnv.WORKER_INGEST_INTERVAL_SECONDS}s over ${feeds.length} feed(s)${feeds.length ? `\n             ${feeds.join('\n             ')}` : ' (no feeds configured — ingestion idle)'}`,
      `  dispatch : every ${botEnv.WORKER_DISPATCH_INTERVAL_SECONDS}s (retries ≤ ${botEnv.NOTIFICATION_RETRY_MAX})`,
      `  stats    : snapshot daily at ${String(statsEnv.STATS_SNAPSHOT_UTC_HOUR).padStart(2, '0')}:00 UTC (check every ${statsEnv.STATS_CHECK_INTERVAL_SECONDS}s, backfill ≤ ${statsEnv.STATS_BACKFILL_DAYS}d)`,
      `  auto-publish ingested jobs: ${botEnv.AUTO_PUBLISH_INGESTED_JOBS ? 'yes' : 'no (drafts await /publish)'}`,
      `  heartbeat: ${HEARTBEAT_FILE}`,
      '',
    ].join('\n'),
  )

  // Guard flags so a slow pass is never started twice by the interval timer.
  let ingestBusy = false
  let dispatchBusy = false
  let statsBusy = false

  const runGuarded = async (busy: () => boolean, set: (v: boolean) => void, fn: () => Promise<void>) => {
    if (busy()) return
    set(true)
    try {
      await fn()
      touchHeartbeat()
    } finally {
      set(false)
    }
  }

  // First pass immediately (catch up on anything published while we were down),
  // then on fixed intervals.
  void runGuarded(() => ingestBusy, (v) => (ingestBusy = v), tickIngest).catch((err) => console.error(err))
  void runGuarded(() => dispatchBusy, (v) => (dispatchBusy = v), tickDispatch).catch((err) => console.error(err))
  void runGuarded(() => statsBusy, (v) => (statsBusy = v), tickStats).catch((err) => console.error(err))

  const ingestTimer = setInterval(
    () => void runGuarded(() => ingestBusy, (v) => (ingestBusy = v), tickIngest).catch((err) => console.error(err)),
    botEnv.WORKER_INGEST_INTERVAL_SECONDS * 1000,
  )
  const dispatchTimer = setInterval(
    () => void runGuarded(() => dispatchBusy, (v) => (dispatchBusy = v), tickDispatch).catch((err) => console.error(err)),
    botEnv.WORKER_DISPATCH_INTERVAL_SECONDS * 1000,
  )
  const statsTimer = setInterval(
    () => void runGuarded(() => statsBusy, (v) => (statsBusy = v), tickStats).catch((err) => console.error(err)),
    statsEnv.STATS_CHECK_INTERVAL_SECONDS * 1000,
  )
  const heartbeatTimer = setInterval(touchHeartbeat, 15_000)
  heartbeatTimer.unref?.()

  // Graceful shutdown (docker stop / SIGINT).
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log('main', `received ${signal} — shutting down`)
    clearInterval(ingestTimer)
    clearInterval(dispatchTimer)
    clearInterval(statsTimer)
    clearInterval(heartbeatTimer)
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('[worker] fatal:', err)
  process.exit(1)
})
