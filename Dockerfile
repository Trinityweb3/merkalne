# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Merklane — multi-stage production image
#
#   deps    — install dependencies with Bun (fast, cached lockfile layer)
#   builder — generate the Prisma client (PostgreSQL) and build the Next.js
#             standalone output
#   runner  — minimal runtime, non-root user, healthcheck baked in
#
#   All stages must run the same Bun line. Bun 1.3 is pinned because the
#   repo ships the text-based bun.lock (lockfileVersion 1, introduced in
#   Bun 1.2). Bun 1.1 images only understand the legacy binary bun.lockb
#   and fail with InvalidLockfileVersion.
#
# Build:  docker build -t merklane .
# Run:    docker compose up -d   (see docker-compose.yml)
# ---------------------------------------------------------------------------

FROM oven/bun:1.3-slim AS deps
WORKDIR /app
# Fail fast with a named error if the build container cannot reach the npm
# registry. A silent multi-minute stall at "bun install" is almost always a
# build-container networking problem; this probe turns it into a one-second
# diagnosis and prints real throughput so a slow (vs broken) route is visible.
RUN bun -e 'const t=Date.now();fetch("https://registry.npmjs.org/next").then(async r=>{if(!r.ok)throw new Error("HTTP "+r.status);const b=await r.arrayBuffer();const mb=b.byteLength/1048576;const s=(Date.now()-t)/1000;console.log("[net-probe] registry OK — "+mb.toFixed(1)+" MB in "+s.toFixed(1)+"s ("+(mb/s).toFixed(1)+" MB/s)")}).catch(e=>{console.error("[net-probe] build container cannot reach registry.npmjs.org: "+String(e));process.exit(1)})'
# Dependencies first for layer caching.
COPY package.json bun.lock ./
# --dry-run verifies lockfile↔manifest consistency offline in milliseconds.
# If this passes but the next line stalls, the problem is the network path,
# not the repo.
RUN bun install --frozen-lockfile --dry-run
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------

FROM oven/bun:1.3-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Stale-merge guard — refuse to build a tree that mixes this bundle with an
# older (pre-i18n) Merklane checkout. Extracting over an old tree leaves the
# old root pages (src/app/[section]/, …) in place; Next.js then fails deep
# inside `next build` with a cryptic "Ambiguous app routes detected" error.
# This check names the problem and the fix in plain language, before any
# expensive build step runs.
RUN sh docker/check-app-tree.sh

# The Prisma client is generated for PostgreSQL (the production provider).
# A dummy DATABASE_URL satisfies schema validation; no connection is made.
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV DATABASE_URL=$DATABASE_URL
RUN bunx prisma generate

# Next.js config uses output:"standalone" — the build is self-contained.
# Skip the post-build copy scripts (they patch .next/standalone for the
# non-Docker `npm start` flow and are unnecessary here).
RUN bunx next build

# Bundle the background worker (feed ingestion + premium dispatch) as a
# single standalone file. @prisma/client stays external on purpose: the
# generated client resolves its query engine from node_modules at runtime,
# which the runner stage below already ships.
RUN bun build worker/worker.ts --target=bun \
      --external @prisma/client \
      --external .prisma/client \
      --outfile dist/worker.js

# ---------------------------------------------------------------------------

FROM oven/bun:1.3-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Create a dedicated non-root user.
RUN groupadd --system --gid 1001 merklane \
  && useradd --system --uid 1001 --gid merklane merklane

# Standalone server + static assets + FULL node_modules.
# NOTE: the entrypoint invokes the pinned CLI directly via
# node_modules/prisma/build/index.js — NEVER `bunx`, which (without
# node_modules/.bin in this image) mis-resolves and tries to download
# prisma@latest from the npm registry at runtime.
COPY --from=builder --chown=merklane:merklane /app/.next/standalone ./
COPY --from=builder --chown=merklane:merklane /app/.next/static ./.next/static
COPY --from=builder --chown=merklane:merklane /app/public ./public
COPY --from=builder --chown=merklane:merklane /app/dist/worker.js ./dist/worker.js

# Prisma schema + migrations — required by the boot-time `migrate deploy`.
COPY --from=builder --chown=merklane:merklane /app/prisma ./prisma

# FULL node_modules from the builder stage. This guarantees every runtime
# import resolves: the pinned Prisma CLI (node_modules/prisma, exact version
# the client was generated from), the generated client (node_modules/.prisma
# + node_modules/@prisma), bcryptjs for prisma/seed.ts, and anything else
# the server or maintenance scripts reach for. It costs image size (the dev
# toolchain is included) — a deliberate trade for zero runtime surprises.
COPY --from=builder --chown=merklane:merklane /app/node_modules ./node_modules

# Belt-and-braces (already inside the full copy above; kept as explicit,
# documented lines because a missing one of these has crashed production
# boots before): the seed script's bcryptjs dependency.
COPY --from=builder --chown=merklane:merklane /app/node_modules/bcryptjs ./node_modules/bcryptjs

# App source + maintenance scripts. scripts/set-telegram-webhook.ts and
# scripts/register-discord-commands.ts import from ../src/lib/bots — shipping
# src/ lets every one-shot admin script run inside the container.
COPY --from=builder --chown=merklane:merklane /app/src ./src
COPY --from=builder --chown=merklane:merklane /app/scripts ./scripts
COPY --from=builder --chown=merklane:merklane /app/package.json ./package.json
COPY --from=builder --chown=merklane:merklane /app/bun.lock ./bun.lock

# Migrations run on boot (idempotent), then the server starts.
COPY --chown=merklane:merklane docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER merklane
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "server.js"]
