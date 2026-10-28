#!/bin/sh
# ---------------------------------------------------------------------------
# Merklane — stale-merge guard
#
# Fails the build IMMEDIATELY (with instructions) when src/app contains files
# from an older, pre-i18n Merklane checkout. This happens when the bundle is
# extracted over an existing tree instead of into a clean directory: tar only
# overwrites files, it never deletes what is already there, so the old root
# pages (src/app/[section]/, src/app/layout.tsx, …) survive next to the new
# src/app/[locale]/ structure. Next.js then aborts with a cryptic
# "Ambiguous app routes detected: /[locale] vs /[section]" error deep inside
# `next build` — minutes into the build, with no hint about the real cause.
#
# This script runs at the very start of the Docker builder stage (and in the
# export pre-flight) so the failure is named, explained and fixed in one line.
#
# Allowed top-level entries in src/app (update this list ONLY when the layout
# legitimately changes — e.g. a new app-level convention file):
#   [locale]/           every page + the root layout (i18n)
#   api/                route handlers (locale-independent)
#   globals.css         global stylesheet (the current de-slopped design)
#   globals.legacy.css  the pre-redesign stylesheet, kept as a backup
#   robots.ts           robots.txt generator
#   sitemap.ts          sitemap generator
# ---------------------------------------------------------------------------
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
app_dir="${here}/../src/app"

if [ ! -d "${app_dir}" ]; then
  echo "ERROR: src/app not found — this is not a complete Merklane tree." >&2
  exit 1
fi
if [ ! -d "${app_dir}/[locale]" ]; then
  echo "ERROR: src/app/[locale] is missing." >&2
  echo "  The i18n bundle keeps every page under src/app/[locale]; a tree" >&2
  echo "  without it is not buildable. Re-extract the bundle into a clean" >&2
  echo "  directory (README.md, section \"Clean redeploy\")." >&2
  exit 1
fi

cd "${app_dir}"
stale=""
for entry in *; do
  case "${entry}" in
    '[locale]'|api|globals.css|globals.legacy.css|robots.ts|sitemap.ts) ;;
    *) stale="${stale}  ${entry}\n" ;;
  esac
done

if [ -n "${stale}" ]; then
  echo "ERROR: stale files from an OLDER Merklane version detected in src/app:" >&2
  printf "${stale}" >&2
  echo "" >&2
  echo "  This bundle was extracted over a pre-i18n checkout. Tar overwrites" >&2
  echo "  files but never deletes old ones, so the old root pages survived" >&2
  echo "  next to the new src/app/[locale]/ structure — Next.js cannot have" >&2
  echo "  two dynamic segments ([locale] and [section]) at the same level," >&2
  echo "  hence \"Ambiguous app routes detected\"." >&2
  echo "" >&2
  echo "  Fix — redeploy into a CLEAN directory (2 minutes):" >&2
  echo "    1) cp .env /tmp/merklane.env                 # back up your config" >&2
  echo "    2) cd .. && rm -rf <project-dir> && mkdir <project-dir>" >&2
  echo "    3) tar -xzf merklane-project.tar.gz -C <project-dir> --strip-components=1" >&2
  echo "    4) cp /tmp/merklane.env <project-dir>/.env" >&2
  echo "    5) cd <project-dir> && docker compose up -d --build" >&2
  echo "" >&2
  echo "  (setup-project.sh does this automatically — it refuses non-empty dirs.)" >&2
  echo "  Details: README.md, section \"Clean redeploy\"." >&2
  exit 1
fi

echo "[app-tree] src/app is clean — pages under [locale]/, no stale merge."
