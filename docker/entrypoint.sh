#!/bin/sh
# ---------------------------------------------------------------------------
# Merklane container entrypoint
#
#   1. wait until the database accepts TCP connections (plain socket probe —
#      no prisma CLI, no registry access, no DNS beyond the host itself)
#   2. apply pending Prisma migrations (idempotent)
#   3. optionally seed the database (SEED_ON_BOOT=true)
#   4. hand off to the CMD
#
# WHY THE CLI IS INVOKED DIRECTLY — NEVER `bunx`:
#   The runner image ships node_modules/prisma (the pinned CLI, same version
#   the client was generated from) but NOT node_modules/.bin. `bunx` resolves
#   that as "not installed locally", then silently falls back to
#   `bun add prisma@latest` from the npm registry — which is unreachable from
#   the bridge network (hangs the boot for minutes) and, even where reachable,
#   would race an unpinned @latest CLI against the pinned client and mutate
#   the running container's node_modules. A direct file invocation has no
#   resolution semantics to get wrong and needs no network at all.
# ---------------------------------------------------------------------------
set -e

echo "[entrypoint] Merklane starting…"

# --- the pinned CLI, straight from the image --------------------------------
# Relative to WORKDIR (/app in the container), like the seed call below —
# never `bunx`: see the header note.
PRISMA_CLI="node_modules/prisma/build/index.js"
if [ ! -f "$PRISMA_CLI" ]; then
  echo "[entrypoint] FATAL: pinned Prisma CLI missing at $PRISMA_CLI — image is broken" >&2
  exit 1
fi

# --- tunables (env-overridable; defaults sized against the compose app
#     healthcheck budget: start_period 30s + 3 x 30s ≈ 120s, so the entrypoint
#     gives up BEFORE Docker declares the container unhealthy, letting the
#     restart policy take over instead of wedging a half-booted container) --
WAIT_ATTEMPTS="${WAIT_ATTEMPTS:-45}"     # TCP-readiness retries (x ~2s each)
WAIT_SLEEP="${WAIT_SLEEP:-2}"            # seconds between TCP probes
MIGRATE_ATTEMPTS="${MIGRATE_ATTEMPTS:-5}"  # retries for connectivity-class failures
MIGRATE_SLEEP="${MIGRATE_SLEEP:-3}"      # seconds between migrate retries

if [ -n "$DATABASE_URL" ]; then
  # --- database host:port, derived from DATABASE_URL ------------------------
  # postgresql://user:pass@host:port/db?params  →  host + port (default 5432)
  u="${DATABASE_URL#*://}"   # strip scheme
  u="${u%%/*}"               # strip path (and ?query)
  u="${u##*@}"               # strip userinfo (user:pass@)
  DB_HOSTNAME="${u%%:*}"
  DB_PORT="${u##*:}"
  if [ -z "$DB_HOSTNAME" ]; then DB_HOSTNAME=db; fi
  if [ -z "$DB_PORT" ] || [ "$DB_PORT" = "$DB_HOSTNAME" ]; then DB_PORT=5432; fi

  # --- 1. TCP readiness -----------------------------------------------------
  # A bare socket test answers "is anything accepting connections here?" in
  # milliseconds. It deliberately does NOT use the prisma CLI: coupling the
  # readiness check to the heavyweight tool is what made the original loop
  # fail together with the thing it was checking. The probe itself is silent
  # by design (exit code only); the redirect below therefore hides nothing —
  # migrate output further down is never redirected.
  db_probe() {
    DB_HOSTNAME="$DB_HOSTNAME" DB_PORT="$DB_PORT" bun -e '
      const net = require("net");
      const sock = net.connect(Number(process.env.DB_PORT), process.env.DB_HOSTNAME);
      const kill = setTimeout(() => { sock.destroy(); process.exit(1); }, 2000);
      sock.on("connect", () => { clearTimeout(kill); sock.destroy(); process.exit(0); });
      sock.on("error",    () => { clearTimeout(kill); process.exit(1); });
    ' >/dev/null 2>&1
  }

  echo "[entrypoint] waiting for the database at ${DB_HOSTNAME}:${DB_PORT}…"
  i=0
  until db_probe; do
    i=$((i + 1))
    if [ "$i" -ge "$WAIT_ATTEMPTS" ]; then
      echo "[entrypoint] database never became reachable — aborting" >&2
      exit 1
    fi
    echo "[entrypoint] database not reachable yet (attempt ${i}/${WAIT_ATTEMPTS}) — retrying in ${WAIT_SLEEP}s…"
    sleep "$WAIT_SLEEP"
  done
  echo "[entrypoint] database reachable — applying migrations…"

  # --- 2. migrations, with honest error handling -----------------------------
  # Output is captured WITH stderr merged (no 2>/dev/null anywhere): whatever
  # prisma prints on failure goes into the container log in full. Retries are
  # granted ONLY for connectivity-class failures (db briefly not ready); any
  # other error — bad auth, broken migration, missing database — is real and
  # aborts loudly instead of being relabeled "database not ready" 30 times.
  run_migrate() {
    if MIGRATE_OUT="$(bun "$PRISMA_CLI" migrate deploy 2>&1)"; then
      MIGRATE_RC=0
    else
      MIGRATE_RC=$?
    fi
    if [ "$MIGRATE_RC" -eq 0 ]; then
      printf '%s\n' "$MIGRATE_OUT"
      return 0
    fi
    printf '%s\n' "$MIGRATE_OUT" >&2
    case "$MIGRATE_OUT" in
      *P1001*|*P1002*|"Can't reach database server"*|*"still starting up"*|\
      *ECONNREFUSED*|*ETIMEDOUT*|*ECONNRESET*|*"Connection terminated"*)
        return 2    # transient — worth retrying
        ;;
      *)
        return 1    # real error — never retry
        ;;
    esac
  }

  n=0
  while :; do
    if run_migrate; then
      mig_rc=0
    else
      mig_rc=$?
    fi
    if [ "$mig_rc" -eq 0 ]; then
      echo "[entrypoint] migrations applied."
      break
    elif [ "$mig_rc" -eq 2 ]; then
      n=$((n + 1))
      if [ "$n" -ge "$MIGRATE_ATTEMPTS" ]; then
        echo "[entrypoint] migrations keep failing on connectivity — aborting" >&2
        exit 1
      fi
      echo "[entrypoint] database not fully ready yet (attempt ${n}/${MIGRATE_ATTEMPTS}) — retrying in ${MIGRATE_SLEEP}s…"
      sleep "$MIGRATE_SLEEP"
    else
      echo "[entrypoint] migration failed — this is NOT a readiness problem; see the error above. Aborting." >&2
      exit 1
    fi
  done

  # --- 3. optional seed ------------------------------------------------------
  if [ "$SEED_ON_BOOT" = "true" ]; then
    echo "[entrypoint] seeding database (SEED_ON_BOOT=true)…"
    if bun prisma/seed.ts; then
      echo "[entrypoint] seed complete."
    else
      echo "[entrypoint] seed failed — continuing (the error above is real, not masked)" >&2
    fi
  fi
else
  echo "[entrypoint] DATABASE_URL not set — skipping migrations." >&2
fi

# --- 4. hand off ------------------------------------------------------------
echo "[entrypoint] handing off to: $*"
exec "$@"
