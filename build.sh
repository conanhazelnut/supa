#!/usr/bin/env bash
# Build native `supa` binaries from supa.ts into ./dist (gitignored).
#
#   ./build.sh              build for this host + Windows x64
#   ./build.sh host         build only for this host
#   ./build.sh windows      build only the Windows .exe
#
# `deno compile` bundles the Deno runtime, so the person running the binary
# needs nothing installed (Docker + the Supabase CLI aside). The first
# cross-compile downloads the target runtime once into $DENO_DIR.
set -euo pipefail
cd "$(dirname "$0")"

PERMS=(--allow-read --allow-write --allow-env --allow-run)
mkdir -p dist
want="${1:-all}"

build_host() {
  echo "▶ host ($(uname -s) $(uname -m)) → dist/supa"
  deno compile "${PERMS[@]}" --output dist/supa supa.ts
}
build_windows() {
  echo "▶ windows (x86_64) → dist/supa.exe"
  deno compile "${PERMS[@]}" --target x86_64-pc-windows-msvc --output dist/supa.exe supa.ts
}

case "$want" in
  host)    build_host ;;
  windows) build_windows ;;
  all)     build_host; build_windows ;;
  *) echo "usage: ./build.sh [host|windows|all]" >&2; exit 1 ;;
esac

echo "✓ done:"
ls -lh dist/ | grep -E 'supa' || true
