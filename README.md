# Merklane — Explore Web3

A production-ready full-stack implementation of the Merklane platform: Web3, crypto, blockchain and AI jobs, opportunities, market signals and insights — with authentication (Google OAuth, GitHub OAuth, email/password, magic links), transactional email via Resend, a fully wired JSON API, and first-class Docker deployment.

Built with **Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Prisma · PostgreSQL · Resend**.

---

## Table of contents

1. [Feature overview](#feature-overview)
2. [Architecture](#architecture)
3. [Repository layout](#repository-layout)
4. [Quick start (Docker — recommended)](#quick-start-docker--recommended)
5. [Quick start (local development)](#quick-start-local-development)
6. [Environment variables](#environment-variables)
7. [OAuth setup (Google & GitHub)](#oauth-setup-google--github)
8. [Resend email setup](#resend-email-setup)
9. [Database & migrations](#database--migrations)
10. [Security model](#security-model)
11. [API reference](#api-reference)
12. [Testing the flows](#testing-the-flows)
13. [Bots & background workers](#bots--background-workers)
14. [About page: team & daily statistics](#about-page-team--daily-statistics)

---

## Feature overview

**Frontend (pixel-faithful to the reference design)**

- Original template design system (restored 2026-10-28 — the de-slopped editorial redesign was rolled back): Inter font, rounded bordered cards; newer feature UI (ads dashboard, ad slots, operator CMS blocks on /about) builds on standard Tailwind/shadcn utilities over the same design tokens, so everything stays visually coherent
- Home with hero search, quick links and the six content rails (Intern/Junior, Mid/Senior, Opportunities, Markets, Insights, Blog)
- Section pages with filter dropdowns, progressive "Load more" pagination and empty states
- Full article pages with sanitised markdown rendering, hashtags, view/like/dislike/report row and comments
- Search page with match highlighting (`<mark>`), snippets around the first match and numbered pagination
- Auth screens: login/register with Google, GitHub, email/password and magic links
- Profile cabinet: overview, bookmarks, my posts, security (password, email change, session management) and the free Blog composer
- `/ads` — advertiser dashboard: create campaigns, watch the weighted auction spend live, top up with crypto (auth-gated; anonymous visitors land on the login screen)
- `/premium` pricing page (monthly/yearly toggle, FAQ) wired to an honest "payments not launched" API
- Global chrome: sticky header with 20-language picker (incl. RTL), theme toggle, mobile drawer, donation side-tab, cookie consent with granular preferences, first-visit safety notice, persistent footer safety text
- **About page as a live investor page**: team cards (initials avatars, no assets needed), daily statistics snapshot ("Merklane as of …"), monthly recap video slots (click-to-load YouTube embeds) and a pitch-deck card — see [About page: team & daily statistics](#about-page-team--daily-statistics)

**Backend**

- PostgreSQL + Prisma with committed SQL migrations
- Custom authentication: opaque server-side sessions (hashed tokens, HttpOnly cookies, rolling refresh, per-device revocation), bcrypt (cost 12) passwords, single-use hashed email-verification / magic-link / password-reset tokens
- Google & GitHub OAuth 2.0 (authorization-code flow, HMAC-signed expiring state, account linking by verified email)
- Every interactive element wired to a real endpoint — no dead buttons; features that are not live yet answer honestly (e.g. Premium checkout returns 503 with an explanation)
- Rate limiting on all auth/public endpoints, CSRF double-submit + origin validation, Zod validation on every input, security headers (CSP, HSTS, …), enumeration-safe password flows
- **Bots & background workers** (see the dedicated section below): a Telegram admin bot that ingests job postings straight into the database (paste the raw text — it parses everything), a feed-scraper worker, and a premium-alert dispatcher delivering new postings via email (Resend) and Telegram DMs — with an idempotent per-recipient delivery ledger and retries

---

## Architecture

```
                    ┌───────────────────────────────────────────────┐
   Browser ────────►│  Next.js App Router (app + /api route         │
                    │  handlers: Zod-validated, rate-limited,       │
                    │  CSRF-guarded)                                │
                    └───────────────┬───────────────────────────────┘
                                    │
                                    ▼
                                 Prisma ──► PostgreSQL
                                   (users, sessions, posts, comments, reactions,
                                    bookmarks, reports, waitlist, contact,
                                    telegram links,
                                    notification log, ingestion log)
                                    ▲                  ▲
                                    │                  │
        ┌───────────────────────────┴───┐   ┌──────────┴───────────────────┐
        │  Telegram webhooks            │   │  worker process              │
        │  (admin job-ingestion bots:    │   │  (compose service "worker"): │
        │   secret-token / Ed25519       │   │   · scrapes external job     │
        │   verified, admin-gated,       │◄──┤     feeds into drafts        │
        │   Zod-validated, audited)      │   │   · fans new postings out to │
        └────────────────────────────────┘   │     premium subscribers      │
                                             │   · retries failed alerts,   │
        Resend ◄── all transactional email    │     heartbeats for liveness  │
        (verification, magic link, reset,     └──────────────────────────────┘
        waitlist, premium job alerts)
```

**Data model** (`prisma/schema.prisma`): `User`, `Account` (OAuth identities), `Session`, `VerificationToken`, `Post`, `Reaction`, `Bookmark`, `Comment`, `Report`, `WaitlistEntry`, `ContactMessage`, plus the bot tables `TelegramLink`, `TelegramAdminState`, `NotificationLog`, `IngestionLog`.

Design rules applied throughout:

- No Prisma enums or provider-specific column types → the identical schema runs on PostgreSQL (production) and SQLite (lightweight local preview; `prisma/schema.sqlite.prisma` is generated by `scripts/sync-sqlite-schema.ts`)
- Money-like data (`salary`) is a display string; **missing salary is `NULL`, never 0**
- One active reaction per user per post (unique constraint + transactional counter updates)
- Only the SHA-256 hash of session/token secrets is stored

---

## Repository layout

```
├── Dockerfile                  # multi-stage production image (bun → standalone + worker bundle)
├── docker-compose.yml          # app + worker + postgres (healthchecks, volume, network)
├── docker/entrypoint.sh        # wait-for-db → migrate deploy → seed? → serve
├── docker/check-app-tree.sh    # stale-merge guard (first builder step in the Dockerfile)
├── docker/fix-container-network.sh  # host-side bridge-egress doctor (diagnose / --fix)
├── .dockerignore
├── .env.example                # every required variable, documented
├── POST-EXPORT-GUIDE.md        # local setup + cleanup checklist + full .env walkthrough
├── prisma/
│   ├── schema.prisma           # PostgreSQL schema (source of truth)
│   ├── schema.sqlite.prisma    # auto-generated local preview variant
│   ├── migrations/             # 0001 init · 0002 bots/premium · 0003 stats · 0004 translations + admin-bot state
│   └── seed.ts                 # reference dataset + demo accounts
├── worker/
│   └── worker.ts               # background process: feed ingestion + premium dispatch
├── scripts/
│   ├── sync-sqlite-schema.ts   # generates the SQLite preview schema
│   ├── set-telegram-webhook.ts # registers BOTH Telegram webhooks (notifier + admin intake bots)
│   ├── grant-premium.ts        # CLI premium grant/revoke (until billing launches)
│   ├── build-export.sh         # builds the portable export bundle (24+ pre-flight assertions)
│   └── serve-prod.sh           # detached production-server launcher (QA)
├── deploy/
│   └── Caddyfile               # reverse-proxy config for merklane.com → 127.0.0.1:3000
├── docker/
│   ├── entrypoint.sh           # container boot: migrate → seed → serve
│   ├── fix-container-network.sh# bridge-egress doctor (DNS/iptables repairs + probes)
│   └── check-app-tree.sh       # stale-merge guard (wired into the Dockerfile)
├── DEPLOYMENT.md               # VPS guide: Ubuntu prep, transfer, Caddy, UFW, updates
├── docker-compose.yml          # app + worker + db + libretranslate
├── docker-compose.egress.yml   # escape hatch: host networking when the bridge is broken
├── src/
│   ├── proxy.ts                # CSRF cookie seeding, security headers, /profile + /alerts gate (Next 16 proxy)
│   ├── app/
│   │   ├── [locale]/           # EVERY page lives here (20 locales, default en keeps prefix-free URLs)
│   │   │   ├── layout.tsx      #   root layout: <html lang dir>, NextIntlClientProvider
│   │   │   ├── page.tsx        #   home
│   │   │   ├── [section]/      #   section listing + [slug] article pages
│   │   │   └── search/ ads/ premium/ alerts/ auth/ profile/ about/ contact/ …
│   │   └── api/                # all route handlers (see API reference)
│   ├── i18n/
│   │   ├── routing.ts          # next-intl routing (as-needed prefixes)
│   │   ├── navigation.ts       # locale-aware Link/useRouter
│   │   ├── request.ts          # dictionary loader (en fallback)
│   │   └── messages/           # 20 typed dictionaries
│   ├── components/             # site/ design system + providers/ + ui/ (shadcn)
│   └── lib/
│       ├── env.ts              # strict Zod-validated environment
│       ├── db.ts               # Prisma client singleton
│       ├── auth.ts             # sessions, bcrypt, one-time tokens
│       ├── csrf.ts             # double-submit CSRF + origin checks + crypto
│       ├── rate-limit.ts       # sliding-window limiter
│       ├── email.ts            # Resend + branded templates (account mail)
│       ├── validation.ts       # all Zod schemas
│       ├── posts.ts            # shared post queries
│       ├── localize.ts         # DB translation cache (Post.translations) + serving layer
│       ├── translate.ts        # LibreTranslate client (batched, timeouts, circuit breaker)
│       ├── api.ts / api-client.ts  # server/client helpers
│       ├── constants.ts        # sections, languages, filters
│       ├── utils.ts
│       └── bots/               # runtime-agnostic bot subsystem
│           ├── config.ts       #   bot env vars + feature detection (both TG bots)
│           ├── telegram.ts     #   Bot API client (multi-token) + command parser
│           ├── secretbox.ts    #   AES-256-GCM for stored webhook URLs
│           ├── intake.ts       #   shared job-creation path (all channels)
│           ├── feeds.ts        #   external feed scraper/mapper
│           ├── dispatch.ts     #   premium fan-out engine + retries
│           ├── email-alerts.ts #   Resend job-alert template (worker-safe)
│           └── format.ts       #   alert formatters (TG/email)
└── README.md
```

---

## Quick start (Docker — recommended)

Prerequisites: Docker 24+ with the Compose plugin.

```bash
# 1. Configure the environment
cp .env.example .env

# 2. Generate the two required secrets and paste them into .env
openssl rand -base64 48   # → AUTH_SECRET
openssl rand -base64 24   # → POSTGRES_PASSWORD

# 3. Build and launch the whole stack (app + PostgreSQL)
docker compose up -d --build

# 4. Watch the boot log (migrations + optional seed)
docker compose logs -f app
```

The entrypoint waits for PostgreSQL with a plain TCP probe, then applies migrations by invoking the pinned CLI from the image directly (`node_modules/prisma/build/index.js` — never `bunx`, which without `node_modules/.bin` would try to download `prisma@latest` from the npm registry at runtime). Migration output is never suppressed: only connectivity-class failures (P1001/P1002/ECONNREFUSED…) are retried; any other error aborts the boot loudly. Then (only if `SEED_ON_BOOT=true`) it seeds the reference dataset, and starts the server. The **worker** service starts in parallel (same image, `bun dist/worker.js`) and handles feed ingestion + premium job-alert dispatch.

- App: http://localhost:3000
- Healthcheck: http://localhost:3000/api/health
- PostgreSQL is published on `127.0.0.1:5433` for convenience (override with `DB_HOST_PORT` in `.env`; the 5433 default avoids colliding with a native PostgreSQL that owns 5432 — the app itself always connects as `db:5432` over the internal network and never touches this mapping). Host-side access: `psql -h 127.0.0.1 -p 5433 -U merklane`. Remove the port mapping in `docker-compose.yml` for hardened deployments

Seeded demo accounts (only when `SEED_ON_BOOT=true`):

| Account | Password | Note |
| --- | --- | --- |
| `admin@merklane.dev` | `MerklaneAdmin2026` | admin role — change or remove on any real deployment |
| `blogger@merklane.dev` | `MerklaneBlogger2026` | regular user |

### Build hangs at `bun install --frozen-lockfile`

`bun` is silent in non-TTY builds while it downloads, so a healthy install of
this tree (a few hundred MB) finishes in well under two minutes. A silent
half-hour stall at `Step 4/37` is a build-container networking problem, not a
project problem — and a successful `docker pull` proves nothing, because the
daemon pulls on the host stack while build containers go through the Docker
bridge. Confirm in ten seconds:

```bash
sudo docker run --rm oven/bun:1.3-slim bun -e 'fetch("https://registry.npmjs.org/next").then(async r=>{const b=await r.arrayBuffer();console.log("OK",b.byteLength,"bytes")}).catch(e=>{console.error("FAILED:",String(e));process.exit(1)})'
```

If that stalls or fails, it is one of the usual three on Arch:

- **Forwarding rules** — check `sudo sysctl net.ipv4.ip_forward` is `1` and
  `sudo iptables -L FORWARD` does not DROP bridge traffic (common after
  switching to `iptables-nft` or rewriting firewall rules); then
  `sudo systemctl restart docker`.
- **Bridge DNS / IPv6** — the embedded resolver returns AAAA records but the
  host has no working IPv6 route, so fetches stall until timeout.
- **MTU** — VPN tunnels with MTU < 1500 make large TLS records stall
  mid-transfer: the probe connects but never finishes.

This stack builds on the host network (`network: host` under both `build:`
sections in `docker-compose.yml`), which sidesteps all three — only the build
uses the host stack; the running containers stay isolated on the bridge. The
Dockerfile also runs a one-second `[net-probe]` fetch before installing, so a
broken route fails loudly with a named error instead of hanging, and a
`--dry-run` gate first proves the lockfile itself parses. If the probe
succeeds but throughput is low, the host's own route to the registry is the
bottleneck — point `bun` at a mirror via `bunfig.toml` (`[install]` →
`registry = "…"`).

Watch a build live instead of a spinner:

```bash
sudo docker compose build --progress=plain app worker
sudo docker compose up -d
```

### Runtime containers cannot reach the internet (email / OAuth `ConnectionRefused`)

Symptom: the app and worker containers cannot reach `api.resend.com`,
`oauth2.googleapis.com` or `github.com` (magic-link emails never arrive, OAuth
buttons fail), while the same URLs work from the host. Builds succeed because
they run with `network: host` — the *running* containers use the
`merklane-net` bridge, and that path is broken.

Two layers of defense ship with this repo:

1. **Pinned DNS** — `docker-compose.yml` sets `dns: [1.1.1.1, 8.8.8.8]` on the
   app and worker services. Containers on user-defined networks resolve
   external names through Docker's embedded DNS (127.0.0.11), which forwards
   to whatever the host's `/etc/resolv.conf` says — on hosts where that is a
   loopback stub (systemd-resolved `127.0.0.53`) the forward fails. Pinning
   public resolvers bypasses the host stub; container-to-container names
   (`db`) keep resolving through the embedded DNS either way.

2. **Network doctor** — run on the host for a full diagnosis (and `--fix` for
   the safe automatic repairs):

   ```bash
   sudo bash docker/fix-container-network.sh        # diagnose
   sudo bash docker/fix-container-network.sh --fix  # diagnose + repair
   ```

   It checks kernel IP forwarding, Docker's `MASQUERADE` and `FORWARD`
   iptables rules, ufw's forward policy, and probes DNS + TLS from inside the
   running app container. The most common finding on Arch + `iptables-nft` is
   a firewall reload that wiped Docker's rules — fixed by
   `sudo systemctl restart docker` (Docker re-applies its rules) and then
   recreating the stack (`docker compose down && docker compose up -d`).

3. **Guaranteed escape hatch** — if the bridge still refuses after the
   doctor (exotic nftables, VPN MTU, security modules), run the stack with
   runtime host networking via the shipped override file:

   ```bash
   sudo docker compose -f docker-compose.yml -f docker-compose.egress.yml up -d
   ```

   `docker-compose.egress.yml` moves app + worker onto the host network (the
   exact path your builds already use successfully) and repoints their
   `DATABASE_URL` at the db's published host port (`127.0.0.1:5433`). The db
   container stays isolated with its volume. This trades isolation for
   guaranteed egress; the bridge setup is preferred once the host firewall
   is fixed.

### Clean redeploy (fixes broken UI / stale files after re-extracting a bundle)

Every bundle ships a `manifest.sha256` listing the checksum of **every file
in the tree**. If pages look wrong after an upgrade (styles from an older
release, half-updated components), your working tree is almost certainly a
mix of old and new files — tar extracts over an existing tree, so anything
not overwritten stays. Verify in seconds:

```bash
cd ~/merklane/merklane
sha256sum -c manifest.sha256 --quiet   # no output = tree is byte-identical
```

Any line it prints is a file that differs from the bundle (files from older
bundles, or local edits). The clean path:

```bash
cd ~
mv merklane/merklane merklane/merklane.old.$(date +%s)   # keep .env aside!
cp merklane/merklane.old.*/.env /tmp/ 2>/dev/null || true
tar xzf merklane-project.tar.gz -C ~/merklane/            # lands in ~/merklane/merklane
cp /tmp/.env ~/merklane/merklane/.env
cd ~/merklane/merklane
sha256sum -c manifest.sha256 --quiet && echo "tree verified"
sudo docker compose build --no-cache app worker           # no stale layers
sudo docker compose up -d
```

The archive contains exactly one top-level directory (`merklane/`), so
extracting with `-C ~/merklane/` places files directly into
`~/merklane/merklane` — never into `~/merklane/merklane/merklane`. Never
extract *into* your working directory; extracting over an existing tree is
what creates mixed states. After the redeploy, hard-refresh the browser
(Ctrl+Shift+R) so no cached chunks linger.

**Built-in guard.** The Dockerfile now runs `docker/check-app-tree.sh` as the
first step of the builder stage. If `src/app` contains anything beyond the
expected entries (`[locale]/`, `api/`, `globals.css`, `robots.ts`,
`sitemap.ts`) — i.e. leftovers from a pre-i18n bundle such as
`src/app/[section]/` or the old root `src/app/layout.tsx` — the build stops
immediately with a named diagnosis and the fix steps above, instead of
failing minutes later inside `next build` with a cryptic
`Ambiguous app routes detected: /[locale] vs /[section]` error. If you ever
see that Next.js error, it means the same thing: stale files; clean-redeploy.

---

## Quick start (local development)

Prerequisites: Node 20+/Bun 1.2+ (the repo ships the text-based `bun.lock`, which Bun 1.1 cannot parse — same for the Docker image, pinned to `oven/bun:1.3-slim`) and a local PostgreSQL (or use the SQLite preview mode below).

```bash
# 1. Install dependencies
bun install        # or: npm install

# 2. Configure environment
cp .env.example .env
#    → set DATABASE_URL to your local PostgreSQL, AUTH_SECRET, etc.

# 3. Prisma client + migrations
bunx prisma generate
bunx prisma migrate deploy          # or: bunx prisma migrate dev

# 4. (optional) seed the reference dataset
bun prisma/seed.ts

# 5. Run
bun run dev         # http://localhost:3000
```

### SQLite preview mode (no database server)

For quick frontend work the same schema can run on SQLite:

```bash
# .env: DATABASE_URL="file:./db/custom.db" and DATABASE_PROVIDER="sqlite"
bun run db:push     # syncs schema.prisma → schema.sqlite.prisma and pushes it
bun run db:preview:generate
bun prisma/seed.ts
bun run dev
```

Without `RESEND_API_KEY` all transactional emails (verification, magic link, password reset, waitlist) are printed to the server console instead of being sent — every flow stays testable.

---

## Environment variables

Every variable is validated at boot by `src/lib/env.ts` (Zod). The app refuses to start in production with missing/placeholder secrets.

Builds are secret-free by design: `.dockerignore` excludes `.env*`, so `docker build` never sees your secrets — `next build` runs with `NEXT_PHASE=phase-production-build`, which skips the boot assertion during page-data collection. The full strict validation then fires on the real container boot (`app` and `worker`), where the environment comes from `docker-compose.yml`.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string (`postgresql://…`). `file:…` allowed only for SQLite previews. |
| `DATABASE_PROVIDER` | no | `postgresql` (default) or `sqlite` — selects case-insensitive search strategy. |
| `APP_URL` | no | Canonical origin, default `http://localhost:3000`. Used for email links, OAuth redirects, CSRF origin checks. |
| `AUTH_SECRET` | prod | ≥32-byte random secret (`openssl rand -base64 48`). Signs CSRF tokens and OAuth state. |
| `RESEND_API_KEY` | no | Resend API key. Empty → emails are logged to console (dev mode). |
| `EMAIL_FROM` | no | Verified sender, e.g. `Merklane <noreply@yourdomain.com>`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Google OAuth app credentials. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | GitHub OAuth app credentials. |
| `CORS_ALLOWED_ORIGINS` | no | Extra origins allowed to call the API (comma-separated). |
| `POSTGRES_PASSWORD` | compose | Used by `docker-compose.yml` for both the app connection string and the Postgres container. |
| `SEED_ON_BOOT` | no | `true` → the container seeds the reference dataset after migrating. |
| `TELEGRAM_BOT_TOKEN` | no | @BotFather token — **notifier bot**: premium alert DMs + account linking. |
| `TELEGRAM_WEBHOOK_SECRET` | no | Secret token Telegram echoes on notifier-webhook calls (`openssl rand -hex 24`). |
| `TELEGRAM_ADMIN_USER_IDS` | no | Comma-separated Telegram ids allowed to use the admin intake bot. |
| `TELEGRAM_BOT_USERNAME` | no | Notifier bot username (no `@`) for t.me deep links on `/alerts`. |
| `TELEGRAM_ADMIN_BOT_TOKEN` | no | @BotFather token of the **second bot** — admin intake bot (bulk-paste composer, `/addjob /jobs /publish /grant`). |
| `TELEGRAM_ADMIN_WEBHOOK_SECRET` | no | Its own secret token (generate a DIFFERENT `openssl rand -hex 24`). |
| `GROQ_API_KEY` | no | **Primary LLM translator** — Groq free tier (30 RPM / 1 000 req/day, no credit card; console.groq.com → API Keys). Uses `openai/gpt-oss-120b` with `qwen/qwen3.8-27b` as the model fallback; requests are spaced ≈2 s to respect the free-tier RPM. |
| `DEEPSEEK_API_KEY` | no | LLM translator fallback 2 (paid, platform.deepseek.com → `deepseek-chat`). |
| `GOOGLE_AI_API_KEY` | no | LLM translator fallback 3 (aistudio.google.com → Gemini Flash via the OpenAI-compatible endpoint). |
| `LIBRETRANSLATE_URL` | no | Self-hosted LibreTranslate base URL — the **final fallback** when no LLM key is set or the LLM provider fails/rate-limits. Compose wires `http://libretranslate:5000` automatically; empty = no fallback. |
| `LIBRETRANSLATE_API_KEY` | no | Only when LibreTranslate runs with `LT_REQ_API_KEY`. |
| `LIBRETRANSLATE_LOAD_ONLY` | no | Argos language pairs the bundled LibreTranslate loads (memory tuning, see DEPLOYMENT.md §7). |
| `TRANSLATION_GLOSSARY_PATH` | no | Web3 glossary file (protects “On-chain”, “DeFi”, “TVL”, … from literal translation). Default `config/translation-glossary.json` is volume-mounted by compose; re-read every 60 s. Template: `config/translation-glossary.example.json`. |
| `WORKER_ENABLED` | no | `false` → the worker container exits immediately. |
| `WORKER_INGEST_INTERVAL_SECONDS` | no | Feed-ingestion cadence (default 300). |
| `WORKER_DISPATCH_INTERVAL_SECONDS` | no | Premium-dispatch cadence (default 60). |
| `INGEST_FEED_URLS` | no | Comma-separated JSON job feeds (Remotive-compatible or Merklane format). |
| `AUTO_PUBLISH_INGESTED_JOBS` | no | `true` → scraped jobs publish immediately; `false` → drafts for review. |
| `NOTIFICATION_RETRY_MAX` | no | Alert delivery retries before a row is marked skipped (default 3). |
| `TRACKING_ENABLED` | no | Master switch for the anonymous page-view beacon (default `true`). |
| `TRACK_DEDUPE_MINUTES` | no | Same visitor + page counted once per this window (default 30). |
| `STATS_SNAPSHOT_UTC_HOUR` | no | Worker: UTC hour the daily About-page snapshot is computed (default 3). |
| `STATS_CHECK_INTERVAL_SECONDS` | no | Worker: how often to check whether a snapshot is due (default 900). |
| `STATS_BACKFILL_DAYS` | no | Worker: missed past days to backfill snapshots for (default 7). |
| `DONATION_SOL_ADDRESS` | no | Solana donation wallet (SOL). Shown in the support sheet with a copy button; empty = hidden. |
| `DONATION_BTC_ADDRESS` | no | Bitcoin donation wallet (BTC) — legacy, SegWit or Taproot format. |
| `DONATION_USDT_EVM_ADDRESS` | no | Single EVM address for USDT, serving Ethereum, BNB Chain and Arbitrum One (labeled as such). |
| `SOCIAL_VAZIMA_URL` | no | Team card link for Vazima (CEO) on `/about` — opens in a new tab; empty = card renders without a link. |
| `SOCIAL_TRINITY_URL` | no | Team card link for Trinity (Programmer) on `/about`. |
| `SOCIAL_GROBOFHIK_URL` | no | Team card link for Grobofhik (Programmer) on `/about`. |
| `ADS_ENABLED` | no | Master switch for ad SERVING (`true`/`false`, default on). `false` makes every `<AdSlot/>` render nothing while the /ads dashboard keeps working. |
| `ADS_TOPUP_MODE` | no | How a crypto top-up is confirmed: empty/AUTO (default — `blockbee` when `BLOCKBEE_API_KEY` is set, else `manual`), `blockbee`, `manual` (admin confirms) or `simulate` (advertiser self-confirms; demos/local only, never on a public site). |
| `ADS_TOPUP_SEED` | no | Seed for the deterministic deposit-address derivation (mock HD wallet, manual/simulate fallback only). Set a long random string in production; empty = dev default. |
| `BLOCKBEE_API_KEY` | no | BlockBee payment processor API key (https://blockbee.io — formerly CryptAPI). When set, ad top-ups run through BlockBee (hosted deposit addresses, AML screening, ~0.25–1% fees) and referral-payout withdrawals are enabled. Empty = processor disabled (manual top-up fallback, withdrawals off). |
| `BLOCKBEE_IPN_SECRET` | no | Shared secret for HMAC verification of BlockBee webhooks (the `token` param = HMAC-SHA256 over the remaining query string). BlockBee's production RSA scheme (`x-ca-signature` header vs the processor's public key) is verified as well — a webhook is accepted when EITHER passes. Generate with `openssl rand -hex 32`. |
| `BLOCKBEE_COINS` | no | Comma-separated allowlist of BlockBee coin tickers for top-ups and payouts. Default: USDT/USDC on Polygon, BSC and Arbitrum + SOL, BNB, POL (stablecoins and major coins on cheap networks). TRON tickers are ALWAYS rejected (high fraud rate — policy, not overridable). |
| `BLOCKBEE_MIN_PAYOUT_CENTS` | no | Minimum referral withdrawal in US cents (default 2000 = $20.00). |

A line-by-line "where to get it" walkthrough for every variable lives in [POST-EXPORT-GUIDE.md](POST-EXPORT-GUIDE.md).

---

## Internationalization (20 languages, real URLs)

The whole interface lives under `src/app/[locale]/` with
[next-intl](https://next-intl.dev):

- **Default locale `en` keeps prefix-free URLs** (`/about`, `/blog/…`) — every
  existing link and bookmark keeps working. The other 19 languages get a real
  prefix: `/ru/about`, `/es/search`, `/ar/markets`, … (`localePrefix:
  'as-needed'` in `src/i18n/routing.ts`).
- **The header language picker actually switches the site**: it navigates to
  the same page in the chosen language, sets the `NEXT_LOCALE` cookie (so the
  choice survives reloads; the edge proxy resolves cookie → Accept-Language →
  default) and best-effort syncs the preference to the signed-in account.
- **RTL just works**: `src/app/[locale]/layout.tsx` sets `<html lang dir>` —
  Arabic, Persian and Urdu render right-to-left.
- **Dictionaries** live in `src/i18n/messages/*.ts` — one file per language,
  each typed against the English reference (`Messages`), so a missing key is
  a compile error. UI chrome (navigation, footer, cookie banner, auth, search,
  donations, common buttons/errors) is translated; editorial content (posts,
  long marketing copy) stays in its published language.
- **Stats stay locale-neutral**: the tracking beacon buckets `/ru/markets`
  with `/markets` (locale prefixes are stripped in `deriveSection`).
- **Job content is machine-translated on demand** (provider chain:
  **Groq → DeepSeek → Gemini → self-hosted LibreTranslate**, DB-cached per
  post+language in `Post.translations`): localized list pages
  translate **title + card snippet**, article pages translate
  **title + body** — everything a reader sees except the hashtags. The first uncached view
  waits a bounded few seconds for the translation and falls back to the
  English original while the translation keeps filling the cache in the
  background (the next view is fully localized); any failure (provider down,
  rate limit, no Argos model for a locale, body > 20 000 chars) falls back to
  English — a broken translator can never break or slow a page beyond that
  budget. An LLM provider that rate-limits (429) cools down for its
  Retry-After window and LibreTranslate serves meanwhile; the active provider
  is shown on the About page ("Translation via Groq …").
  See “Bots & background workers → Machine translation” and DEPLOYMENT.md §7.
- **Hashtags are functional identifiers and are NEVER translated**
  (`#crypto`, `#defi`, `#rust` …): they render as hashtags, power
  `/search?q=%23tag` lookups and the tag filters, so they stay byte-identical
  English in every locale. Tags are never sent to the translator and are not
  persisted to the translation cache; inline hashtags inside titles/bodies/
  snippets are swapped for ⟦N⟧ placeholders before every request (LLM and
  LibreTranslate lanes alike) and restored afterwards. Markdown ATX headings
  (`# Heading`) are not treated as hashtags.
- **Section names stay English in every locale** (Intern/Junior, Mid/Senior,
  Opportunities, Markets, Insights, Blog): they double as routing slugs and
  DB section values, so the i18n keys (`nav.internJunior`, …) return the
  English string in all 20 dictionaries — keeping search, filtering and URLs
  consistent. Descriptions under them are translated normally.
- **LLM translations use a Web3-hardened prompt** (`src/lib/translate.ts`):
  a system prompt fixes industry terminology (DeFi, on-chain, TVL, AMM, DEX,
  DAO, NFT, Layer 2, … — keep the community term, or the English word when
  no established translation exists), pins URLs/`$TICKER`s/handles, demands
  the exact ⟦N⟧ glossary placeholders back, never translates hashtags
  (words starting with `#` — search keywords), and returns strict JSON;
  identical strings in a batch are de-duplicated to conserve free-tier
  tokens, and every provider request is serialized with ≈2 s spacing
  (Groq free tier = 30 req/min).
- **Web3 jargon is protected by a custom glossary** (`src/lib/translation-glossary.ts`
  + `config/translation-glossary.json`): terms like On-chain, DeFi, TVL, AMM,
  DAO, NFT are swapped for opaque placeholders before each LibreTranslate
  request and stitched back afterwards — never translated literally. The
  custom file can map per-language replacements ("Yield farming" → ru
  "Фарминг доходности") or un-protect a term per language (""), wins over the
  built-in defaults term by term, and is re-read every 60 s without a restart.
- Adding a language = one entry in `LANGUAGES` (`src/lib/constants.ts`) + one
  dictionary file; the routing, switcher and proxy pick it up.

---

## OAuth setup (Google & GitHub)

**Google** (https://console.cloud.google.com/apis/credentials)

1. Create an *OAuth client ID → Web application*
2. Authorised redirect URI: `{APP_URL}/api/auth/oauth/google/callback`
3. Copy client id/secret into `.env`

**GitHub** (https://github.com/settings/developers)

1. *New OAuth App*
2. Authorization callback URL: `{APP_URL}/api/auth/oauth/github/callback`
3. Copy client id/secret into `.env`

Both providers are optional: when unconfigured, their buttons still call the API, which answers honestly (503) with setup instructions instead of pretending. One account can link several providers — GitHub/Google sign-in matches accounts by **verified** email only, and every OAuth user can additionally set a password from Security.

> **Callback URL checklist** — with the default `.env` (`APP_URL=http://localhost:3000`)
> the exact URIs to register are:
>
> - Google: `http://localhost:3000/api/auth/oauth/google/callback`
> - GitHub: `http://localhost:3000/api/auth/oauth/github/callback`
>
> If you change `APP_URL` (domain, port, HTTPS), update the provider consoles
> to match — a mismatch shows as `redirect_uri_mismatch` at the provider, NOT
> as "The external sign-in failed". That generic message with
> `ConnectionRefused` in the app logs means the **container could not reach
> oauth2.googleapis.com/github.com at all** — see *Runtime containers cannot
> reach the internet* above.

---

## Resend email setup

1. Create an account at https://resend.com and verify your sending domain
2. Create an API key and set `RESEND_API_KEY`
3. Set `EMAIL_FROM` to a verified address (e.g. `Merklane <noreply@merklane.com>`)

Templates (branded dark email matching the site) are in `src/lib/email.ts`:

| Email | Trigger | Lifetime |
| --- | --- | --- |
| Verify your email | registration / email change | 24 h, single use |
| Sign-in link | magic-link request | 15 min, single use |
| Reset your password | forgot-password request | 60 min, single use |
| Waitlist confirmation | `/ads` signup | — |

---

## Database & migrations

```bash
bunx prisma migrate deploy     # apply committed migrations (production)
bunx prisma migrate dev        # create a new migration from schema changes
bunx prisma studio             # browse data
bun prisma/seed.ts             # (re)apply the reference dataset — idempotent
```

- Migrations live in `prisma/migrations/` (provider: `postgresql`)
- The Docker image runs `migrate deploy` automatically on boot
- Re-running the seed is safe: existing rows (by slug/email) are skipped

---

## Security model

| Threat | Mitigation |
| --- | --- |
| Password theft | bcrypt cost 12; passwords never logged; constant-work compare on login |
| Session theft | Opaque 256-bit tokens, HttpOnly + Secure + SameSite=Lax cookies, only hashes stored, instant revocation, 30-day rolling expiry |
| CSRF | Origin/Referer validation **and** double-submit cookie (`X-CSRF-Token`) on every mutating endpoint; OAuth `state` is HMAC-signed and expiring |
| XSS | React auto-escaping; post bodies rendered through react-markdown with a strict component whitelist (raw HTML never rendered); links forced to `noopener noreferrer` and http(s) only |
| SQL injection | Prisma parameterised queries exclusively |
| Enumeration | Login/forgot/magic-link responses are identical for known and unknown accounts |
| Brute force / abuse | Sliding-window rate limits per IP on every auth + public mutation endpoint (login 10/min, register 5/10min, waitlist 6/10min, …) |
| Token replay | Verification/reset/magic tokens are single-use, hashed at rest, short-lived, and re-issuing invalidates prior ones |
| Clickjacking / sniffing / transport | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, HSTS, strict CSP, `Referrer-Policy`, `Permissions-Policy` (next.config.ts + proxy) |
| Secret leakage | Strict Zod-validated env; production boot refuses placeholder secrets; `.env` excluded from the image via `.dockerignore` |
| Privilege escalation | Role/ownership checks are server-side on every post mutation; the client never supplies `role`/`authorId`/`status` as truth |

**Session management UX**: the Security page lists every active session (device, IP, last activity) with per-session and bulk revocation; a password reset signs out all devices; a password change rotates the current session.

---

## API reference

All endpoints return `{ ok: true, data }` or `{ ok: false, error, issues? }`. Mutations require the `X-CSRF-Token` header (handled automatically by the bundled `api()` client) and same-origin `Origin`/`Referer`.

### Auth

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/register` | email+password signup → session + verification email |
| POST | `/api/auth/login` | email+password login |
| POST | `/api/auth/logout` | destroy current session |
| GET | `/api/auth/session` | current user + bookmarked slugs |
| GET | `/api/auth/providers` | which OAuth providers are configured |
| GET | `/api/auth/oauth/{google\|github}` | start OAuth (signed state) |
| GET | `/api/auth/oauth/{provider}/callback` | finish OAuth → session |
| POST | `/api/auth/magic-link` | request magic link (enumeration-safe) |
| POST | `/api/auth/magic-link/verify` | consume magic-link token → session |
| POST | `/api/auth/verify-email/request` | resend verification email |
| POST | `/api/auth/verify-email` | consume verification token |
| POST | `/api/auth/forgot-password` | request reset link (enumeration-safe) |
| POST | `/api/auth/reset-password` | consume reset token, set password, revoke sessions |

### Account

| Method | Path | Description |
| --- | --- | --- |
| PUT | `/api/account/profile` | update name/bio/links |
| PUT | `/api/account/password` | change password (re-auth required) |
| PUT | `/api/account/email` | request email change (token-confirmed) |
| GET/DELETE | `/api/account/sessions` | list / revoke-all-others |
| DELETE | `/api/account/sessions/{id}` | revoke one session |
| GET | `/api/account/bookmarks` | saved posts |
| GET | `/api/account/stats` | personal counters |

### Content

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/posts` | list with `section,kind,workplace,employment,level,tag,q,page,pageSize,sort`; `authorId=me&status=all` for own posts |
| POST | `/api/posts` | create (Blog for everyone; editorial sections admin-only until Premium+) |
| GET/PUT/DELETE | `/api/posts/{slug}` | detail / update (owner or admin) / soft delete |
| POST | `/api/posts/{slug}/reaction` | set/replace/clear like·dislike (send `none` to clear) |
| POST | `/api/posts/{slug}/bookmark` | toggle bookmark |
| GET/POST | `/api/posts/{slug}/comments` | list / add comment |
| POST | `/api/posts/{slug}/report` | report post (guests allowed) |
| POST | `/api/posts/{slug}/view` | view counter with 12 h cookie dedup |
| GET | `/api/search` | editorial search (Blog excluded), 10/page, newest first |

### Misc

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | liveness + DB check (Docker healthcheck) |
| POST | `/api/waitlist` | Merklane Ads waitlist (idempotent, Resend confirmation) |
| GET | `/api/ads/serve?slot=…` | one weighted-random auction pick for a slot (204 when nothing eligible — no empty boxes) |
| POST | `/api/ads/click` | record a click on a served impression (same-origin enforced, never billed twice) |
| GET/POST | `/api/ads/campaigns` | advertiser: list own campaigns with view/click stats / create (starts paused) |
| PATCH | `/api/ads/campaigns/[id]` | advertiser: pause / resume own campaign (resume needs balance ≥ bid) |
| POST/GET | `/api/ads/topups[/id]` | crypto top-up: create a payment intention (BlockBee hosted address, or the derived mock address in manual/simulate fallback) / poll status |
| POST | `/api/ads/topups/[id]/simulate` | DEMO path — self-confirm a top-up (only when ADS_TOPUP_MODE=simulate) |
| POST | `/api/admin/ads/topups/[id]/confirm` | admin: mark a deposit received, credit the campaign (optional amount override) |
| GET/POST | `/api/webhooks/blockbee` | BlockBee IPN + payout webhooks: signature-verified (RSA `x-ca-signature` and/or HMAC `token`), rate-limited, idempotent — credits campaigns, pays referral commissions, settles withdrawals |
| GET | `/api/account/referral` | referral cabinet: shareable link/code, balance, lifetime stats, withdrawal history |
| POST | `/api/account/referral/withdraw` | pay out the referral balance to the user's crypto address via the BlockBee payout chain (balance deducted only after on-chain confirmation) |
| POST | `/api/contact` | contact form |
| GET/PUT | `/api/preferences` | interface locale (20 languages, RTL-aware) |
| POST | `/api/premium/subscribe` | honest 503 — stage-2 billing placeholder |
| POST | `/api/track` | anonymous page-view beacon for the About statistics (silent 204 on every skip path) |
| GET | `/api/stats/latest` | latest daily statistics snapshot (raw numbers + ISO codes, i18n-neutral) |

### Bots & workers

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/webhooks/telegram` | `X-Telegram-Bot-Api-Secret-Token` | **Notifier bot** (user-facing): `/start <code>`, `/alerts on\|off`, `/unlink`, `/whoami`, `/help` |
| GET | `/api/webhooks/telegram` | — | notifier wiring status (configured, canSend, adminConfigured) |
| POST | `/api/webhooks/telegram-admin` | `X-Telegram-Bot-Api-Secret-Token` | **Admin intake bot** (separate Telegram bot): `/start` menu + bulk-paste job composer (paste raw text → parsed → ✅ Publish), `/addjob /jobs /publish /stats /grant /revoke` |
| GET | `/api/webhooks/telegram-admin` | — | admin-bot wiring status |
| POST | `/api/bots/telegram/link` | session + CSRF | issue one-time t.me linking code (hash stored) |
| PATCH/DELETE | `/api/bots/telegram/link` | session + CSRF | pause/resume DMs · unlink |
| POST | `/api/admin/dispatch` | admin session + CSRF | run dispatch + retry pass immediately |
| POST | `/api/admin/stats` | admin session + CSRF | recompute today's statistics snapshot on demand |
| GET | `/api/admin/dispatch` | admin session | pipeline status: undispatched posts, premium subscribers, ledgers |

Server-to-server webhook endpoints are exempt from browser CSRF (they carry no cookies) and instead authenticate via the Telegram secret token, plus per-chat/user rate limits, admin allowlists and Zod validation on every write.

---

## Testing the flows

1. **Waitlist**: open `/ads`, submit an email → success card; check the console for the dev-mode email (or Resend dashboard in production); submitting the same email again returns "already on the list".
2. **Register + verify**: register on `/auth?mode=register`, copy the verification URL from the console/email, open it → email verified badge on `/profile`.
3. **Magic link**: on `/auth`, enter any email → "Email me a magic link" → open the link → signed in.
4. **Password reset**: `/auth/forgot-password` → open the emailed link → new password → all previous sessions invalidated.
5. **Reactions/bookmarks/comments**: open any post, like/dislike (toggle, switch), save it (guests get a sign-in prompt), post a comment.
6. **Search**: search `solana` → highlighted snippets; `#Frontend` → exact-tag results only (`#Front` does not match `#Frontend`); pagination preserves `q` in the URL.
7. **Security**: `/profile → Security` → see the current session (device/IP), revoke it, confirm the next request redirects to login.
8. **Rate limits**: 11 rapid login attempts with a wrong password → 429 with `Retry-After`.

---

## Merklane Ads — auction, crypto top-ups, placements

Three primitives power the ads system (all money is **US cents** in `Int` columns — portable across PostgreSQL and SQLite):

- **Weighted random auction** (`src/lib/ads/auction.ts`): when a slot asks for an ad, every active campaign whose balance covers its bid enters a roulette-wheel draw weighted by `bidPerView` — a 2¢ bid is picked twice as often as a 1¢ bid. Billing is **atomic per impression** (a conditional `updateMany` guards the decrement, so concurrent requests can never overdraw), each serve writes an `AdImpression` (view), and a drained campaign **auto-pauses** until the next top-up.
- **Crypto top-ups via BlockBee** (`src/lib/ads/blockbee.ts` + `src/lib/ads/topup.ts` + `/api/ads/topups*`): the system no longer generates its own wallets (gas, key-custody and AML exposure) — the external [BlockBee](https://blockbee.io) processor (formerly CryptAPI) hosts the deposit addresses, screens the funds and confirms payments. Creating a top-up calls BlockBee's `/{coin}/create/` endpoint with a callback URL unique per intention (`order_id` + an unguessable `nonce`), gets back a hosted deposit address and shows it with the expected USD amount. The IPN webhook at `/api/webhooks/blockbee` verifies the signature (RSA `x-ca-signature` against the processor's public key and/or HMAC `token` keyed with `BLOCKBEE_IPN_SECRET`), validates `order_id` → pending intention + nonce, and credits the campaign **exactly once** (transaction-guarded status flip) — paying the referrer's 50% commission in the same transaction. Coins: stablecoins + majors on cheap networks (Solana, Polygon, BSC, Arbitrum); **TRON is banned by policy** and cannot be re-enabled via config. Fallback modes for testing/provider outages: `manual` (deterministic mock address, admin confirms via `/api/admin/ads/topups/[id]/confirm`) and `simulate` (advertiser self-confirms; demos only).
- **Referral system — 50% commissions** (`src/lib/referral.ts` + `/api/account/referral*`): every user gets a shareable code (`/auth?mode=register&ref=CODE`); accounts registered with a code are bound to their inviter (write-once, self-referral impossible). When a referred user's top-up is confirmed — by BlockBee IPN, admin confirm or simulate — half of the credited amount lands in the referrer's `referralBalance` (US cents), exactly once, inside the same transaction. The profile's **Referrals** tab shows the share link, live stats and a withdraw form: payouts run through the BlockBee payout chain (`/payout/request/create/` → `/payout/create/` → `/payout/process/`) to the user's own address, and the balance is **deducted only after the payout webhook confirms on-chain** — failed/expired payouts never take the user's money. When the stage-2 Premium billing lands, the same `creditReferralCommission()` helper hooks into its checkout confirmation.
- **Payment audit trail** (`PaymentLog` table): every payment event — IPNs (accepted and rejected), payout transitions, admin/simulate confirms, referral commissions, withdrawal requests — is logged with the BlockBee transaction id (`uuid`/payout id/tx hash) for operator reconciliation in one place.
- **`<AdSlot/>` placements** (`src/components/site/ads/ad-slot.tsx`): home banner below the hero, in-feed cards after the 3rd/6th post on section pages (plus one in the home first rail) and a native card at the bottom of every article. Every placement renders **nothing** on 204 (auction empty / `ADS_ENABLED=false`) — a sold-out auction never leaves empty boxes. Ads are visually distinct by design: a "Sponsored" badge, tinted background and `rel="sponsored"`.

The **`/ads` advertiser dashboard** (auth-gated like the profile cabinet) manages campaigns: create (starts paused — no free impressions), live balance/impressions/clicks/CTR, pause/resume and the crypto top-up modal (coin picker in BlockBee mode) with address polling. e2e: `bash scripts/run-ads-e2e.sh` (42 checks, manual/simulate fallback) + `bash scripts/run-blockbee-e2e.sh` (58 checks — mock processor with real RSA signing: intention → IPN → credit → referral commission → payout chain → webhook settle) + unit: `bun scripts/test-ads-auction.ts` (13 checks).

## Site CMS via the admin bot (team & logo)

The Telegram admin bot doubles as a tiny CMS. **👥 Manage team** per member (Vazima / Trinity / Grobofhik): send a text to replace the bio, send a photo to replace the avatar. **🖼 Change logo** uploads the site logo shown on `/about`. Photos are downloaded from Telegram, stored as base64 data-URLs in the `SiteSetting` table (survive container recreation, no Docker image changes) and rendered with a 60 s read cache. The `/about` page merges: bot upload → static placeholder in `about-content.ts` → localized placeholder text.

---

## Bots & background workers

Two bots + one worker process, all wired into the same Prisma database and sharing one job-creation path (`src/lib/bots/intake.ts`): the **notifier bot** (premium alert DMs, account linking), the **admin intake bot** (bulk-paste job composer + admin commands + the site CMS above) and the **background worker** (feed scraping, alert dispatch, daily stats).

### 1. Job Ingestion Bot (Telegram)

Admins add vacancies straight from Telegram — no admin UI needed. Two ways:

**Bulk paste (the fast path).** Tap ➕ Add job in the admin bot, paste the raw
job text in any format —

```
Company: Northstar Protocol
Title: Senior Rust Engineer
URL: https://…/apply
Salary: $120k–$160k
Type: Full-time
Workplace: Remote
Description: Build the indexing pipeline…
```

— and the parser extracts Title, Company, URL, Section (Intern/Junior,
Mid/Senior, Opportunities, Markets, Insights, Blog), Body and everything else
by label + heuristics. Unlabeled pastes work too: the first line becomes the
title (`Title at Company` splits), the first URL becomes the apply link, and
level/workplace/type keywords (`senior`, `remote`, `full-time`…) are detected
automatically. Confirm the parsed fields with inline buttons — ✅ Publish,
📝 Draft, 🔄 Section to cycle the (guessed) section — one tap and it is live.

**Power one-liner.**

```
/addjob Senior Rust Engineer | Northstar Protocol | https://…/apply | senior | rust,solana
salary=$120k–$160k
workplace=Remote
employment=Full-time
publish=yes
```

- Five pipe-separated fields (title · company · apply URL · section · tags), optional `key=value` lines below; sections accept aliases (`junior`, `mid`, `senior`, `opp`…)
- Jobs land as **drafts** by default (bulk paste defaults to publish); `publish=yes` (or `/publish <id>` later) publishes and immediately triggers premium dispatch
- Every command is: secret-token verified, admin-allowlisted (`TELEGRAM_ADMIN_USER_IDS`), Zod-validated, rate-limited, deduped by URL, and written to `IngestionLog`

Setup:

```bash
# 1. Create the bot with @BotFather → /newbot, copy the token into .env
# 2. Generate a webhook secret and put it in .env
openssl rand -hex 24    # → TELEGRAM_WEBHOOK_SECRET
# 3. Register the webhook (one command, done)
bun scripts/set-telegram-webhook.ts
```

Other commands: `/jobs [n]`, `/publish <id>`, `/stats`, `/grant <email> <days>`, `/revoke <email>` (premium is granted manually until the stage-2 billing launch), plus subscriber-side `/start <code>`, `/alerts on|off`, `/unlink`, `/whoami`.


### 2. Feed-scraper worker (automated API ingestion)

Point `INGEST_FEED_URLS` at any Remotive-shaped API (`https://remotive.com/api/remote-jobs?limit=25` works out of the box) or host a JSON feed in the generic Merklane format:

```json
{ "jobs": [{
    "title": "…", "company": "…", "url": "https://…",
    "section": "mid-senior", "tags": ["rust", "solana"],
    "location": "Remote", "workplace": "Remote", "employment": "Full-time",
    "level": "Senior", "salary": "…", "stack": "Rust",
    "body": "markdown description", "publish": false
  }] }
```

The worker dedupes by URL, infers sections (`intern/junior/mid/senior/opp…` keywords), strips HTML, caps body length, and creates drafts (or publishes when `AUTO_PUBLISH_INGESTED_JOBS=true`).

### 3. Premium Subscriber Notification Bot (dispatch worker)

The moment a posting is published (by bot, feed or web composer) the dispatcher fans it out to every **active premium subscriber** (`User.plan=premium` and not expired) on each enabled channel:

| Channel | How | Guardrails |
| --- | --- | --- |
| Email | Resend (branded alert template) | dev fallback prints to console without a key |
| Telegram | Bot API DM to the linked chat | one-time hashed linking codes, per-user pause |


Guarantees: the `(postId, channel, recipient)` unique index makes delivery **idempotent** — nobody ever receives the same posting twice, even across restarts; failed sends retry up to `NOTIFICATION_RETRY_MAX` times; every event is audited in `NotificationLog` + `IngestionLog`. Publishing also fires an immediate inline dispatch so hot jobs do not wait for the worker tick.

Premium is granted until stage-2 billing ships via the admin bot (`/grant email 30`) or CLI:

```bash
bun scripts/grant-premium.ts user@email.com 30     # grant/extend 30 days
bun scripts/grant-premium.ts user@email.com revoke
```

### Running the worker

```bash
docker compose up -d          # production — "worker" service, heartbeat healthcheck
bun run worker                # local — standalone, same .env
```

Subscribers manage their channels on `/alerts` (Telegram deep-link, session + CSRF protected).

---

---

## About page: team & daily statistics

`/about` doubles as the public investor page: what Merklane is, **live daily statistics**, the team, monthly recap videos and the pitch deck — all in one shareable URL.

### What renders on /about

| Block | Source | Updates |
| --- | --- | --- |
| "Merklane as of `<date>`" statistics | latest `DailyStats` snapshot (computed by the worker) | once per day (or on admin demand) |
| Team cards | `src/lib/about-content.ts` → `TEAM_MEMBERS` | when you edit the file |
| Monthly recap videos | `src/lib/about-content.ts` → `MONTHLY_RECAPS` | one entry per month |
| Pitch deck card | `src/lib/about-content.ts` → `PITCH_DECK` | when you set the PDF URL |

### How the statistics work

1. **Collection** — every page navigation fires an anonymous beacon (`POST /api/track`, see `src/components/site/stats-beacon.tsx`). The server stores one `Visit` row per deduplicated view: path, section bucket, country (from proxy geo headers, `XX` = unknown) and an **irreversible HMAC fingerprint** of IP + user-agent. No raw IP, no user agent, no user id, no cross-site tracking; Do-Not-Track requests are not counted at all. Same visitor + same page counts once per `TRACK_DEDUPE_MINUTES`.
2. **Snapshot** — once per day after `STATS_SNAPSHOT_UTC_HOUR` (default 03:00 UTC) the worker computes a `DailyStats` snapshot: unique visitors for the last 24 h / 7 d / 30 d / 365 d **with % change vs the previous equal-length window**, page views by section (7 d), new posts by section (24 h), active Premium (+ Premium+ once billing launches) subscriptions, advertisers (active campaigns — 0 until Ads launches — plus the live waitlist count), traffic by country (30 d, top 10, with change) and site totals. Missed days are backfilled (`STATS_BACKFILL_DAYS`).
3. **Rendering** — `/about` reads the latest snapshot (`force-dynamic`) and prints it as "Merklane as of October 25, 2026: …". Until the first snapshot exists the page says so honestly instead of showing fake zeros.

Privacy by design: the beacon sets no cookies of its own and the methodology footnote on the page matches what is actually stored. The privacy policy (`/privacy`) documents the measurement in plain language.

### Editing the editable parts

Everything editorial lives in **one file** — `src/lib/about-content.ts`:

```ts
TEAM_MEMBERS: [{ name, role, bio, imageUrl?, links }]   // initials avatar when no image
MONTHLY_RECAPS: [{ title, youtubeId, publishedAt, description? }]  // empty = honest placeholder
PITCH_DECK: { url: string | null }                      // null = "request the deck" → /contact
```

YouTube embeds are click-to-load (nothing is requested from YouTube before the visitor clicks) via the privacy-enhanced `youtube-nocookie.com` domain; the CSP in `next.config.ts` already allows it.

### Manual refresh & demo data

Admins can recompute today's snapshot on demand (e.g. right before sharing the page):

```bash
curl -X POST https://your-host/api/admin/stats   # session cookie + CSRF header required
```

`GET /api/stats/latest` serves the same snapshot as JSON (raw numbers + ISO codes only — a future i18n layer only ever translates labels, never data; there is no locale endpoint today, so the page renders English like the rest of the site).

To preview the layout before real traffic accumulates (screenshots, demos — **never in production**):

```bash
bun scripts/demo-stats.ts        # 60 days of synthetic visits + 30 days of snapshots
bun scripts/demo-stats.ts --reset  # wipe it all — real collection starts fresh
```
