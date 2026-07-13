#!/usr/bin/env bash
# Build native `supa` binaries from main.ts into ./dist (gitignored).
#
#   ./build.sh              build for this host + Windows x64 (quick local dev)
#   ./build.sh host         build only for this host
#   ./build.sh windows      build only the Windows .exe
#   ./build.sh release      build ALL release targets as dist/supa-<target>[.exe]
#
# `deno compile` bundles the Deno runtime and cross-compiles every target from
# any host, so the person running the binary needs nothing installed (Docker +
# the Supabase CLI aside). Release artifacts are normally built by CI on a
# version tag (see .github/workflows/release.yml) and attached to a GitHub
# Release; the install scripts download those. `./build.sh release` is the
# manual equivalent. The first build of each target downloads its runtime once.
set -euo pipefail
cd "$(dirname "$0")"

PERMS=(--allow-read --allow-write --allow-env --allow-run)
mkdir -p dist
want="${1:-all}"

# Release targets — deno compile cross-compiles all of these from any OS.
TARGETS=(
  aarch64-apple-darwin
  x86_64-apple-darwin
  x86_64-unknown-linux-gnu
  aarch64-unknown-linux-gnu
  x86_64-pc-windows-msvc
)

build_host() {
  echo "▶ host ($(uname -s) $(uname -m)) → dist/supa"
  deno compile "${PERMS[@]}" --output dist/supa main.ts
}
build_windows() {
  echo "▶ windows (x86_64) → dist/supa.exe"
  deno compile "${PERMS[@]}" --target x86_64-pc-windows-msvc --output dist/supa.exe main.ts
}
build_release() {
  for t in "${TARGETS[@]}"; do
    out="dist/supa-$t"
    [[ "$t" == *windows* ]] && out="$out.exe"
    echo "▶ $t → $out"
    deno compile "${PERMS[@]}" --target "$t" --output "$out" main.ts
  done
  echo "▶ checksums → dist/SHA256SUMS.txt"
  (
    cd dist
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum supa-* >SHA256SUMS.txt
    else
      shasum -a 256 supa-* >SHA256SUMS.txt
    fi
  )
}

case "$want" in
  host)    build_host ;;
  windows) build_windows ;;
  all)     build_host; build_windows ;;
  release) build_release ;;
  *) echo "usage: ./build.sh [host|windows|all|release]" >&2; exit 1 ;;
esac

echo "✓ done:"
ls -lh dist/ 2>/dev/null || true
