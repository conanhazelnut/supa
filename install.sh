#!/bin/sh
# supa installer (macOS / Linux) — downloads the prebuilt binary for your
# platform from GitHub Releases. No compiler, no Deno required.
#
#   curl -fsSL https://raw.githubusercontent.com/conanhazelnut/supa/main/install.sh | sh
#
# Env overrides:
#   SUPA_VERSION   tag to install (default: latest)
#   SUPA_BIN_DIR   install dir     (default: ~/.local/bin)
set -eu

REPO="conanhazelnut/supa"
BIN_DIR="${SUPA_BIN_DIR:-$HOME/.local/bin}"
VERSION="${SUPA_VERSION:-latest}"

if ! command -v curl >/dev/null 2>&1; then
  echo "supa: 'curl' is required to install. Install curl and re-run." >&2
  exit 1
fi

os="$(uname -s)"
arch="$(uname -m)"
case "$os-$arch" in
  Darwin-arm64)        target="aarch64-apple-darwin" ;;
  Darwin-x86_64)       target="x86_64-apple-darwin" ;;
  Linux-x86_64)        target="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64|Linux-arm64) target="aarch64-unknown-linux-gnu" ;;
  *) echo "supa: unsupported platform '$os-$arch'." >&2
     echo "     Build from source instead: https://github.com/$REPO#build-from-source" >&2
     exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi
url="$base/supa-$target"
sums_url="$base/SHA256SUMS.txt"

# bytes -> MB with one decimal (integer math, POSIX)
fmt_mb() {
  tenths=$(( $1 * 10 / 1048576 ))
  echo "$(( tenths / 10 )).$(( tenths % 10 ))"
}

# curl's --progress-bar flashes an indeterminate "#=O=#" animation while it
# waits on GitHub redirect hops — looks broken. Same approach as wander:
# HEAD for final URL + Content-Length, fetch silently, draw ONE clean bar
# from the file's growth on stderr (only when stderr is a TTY).
download() {
  out="$1"
  src="$2"
  total="" final="" resp=""
  resp=$(curl -fsSIL --proto '=https' --tlsv1.2 -w '\n%{url_effective}' "$src" 2>/dev/null) || resp=""
  if [ -n "$resp" ]; then
    final=$(printf '%s\n' "$resp" | tail -1)
    total=$(printf '%s\n' "$resp" | tr -d '\r' | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')
    case "$total" in ''|*[!0-9]*) total="" ;; esac
  fi
  [ -n "$final" ] || final="$src"

  if [ -n "$total" ] && [ "$total" -gt 0 ] && [ -t 2 ]; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$out" "$final" &
    pid=$!
    # shellcheck disable=SC2064
    trap "kill $pid 2>/dev/null; exit 130" INT TERM
    width=40 size=0 pct=0 filled=0 bar="" rc=0 iter=0
    total_mb=$(fmt_mb "$total")
    while kill -0 "$pid" 2>/dev/null; do
      iter=$(( iter + 1 ))
      size=$(stat -f%z "$out" 2>/dev/null || stat -c%s "$out" 2>/dev/null || echo 0)
      pct=$(( size * 100 / total ))
      [ "$pct" -gt 100 ] && pct=100
      filled=$(( pct * width / 100 ))
      bar=$(printf '%*s' "$filled" '' | tr ' ' '#')
      # cumulative average; each loop tick ~= 0.2s
      printf '\r  %-*s %3d%%  %s/%s MB  %6s MB/s' \
        "$width" "$bar" "$pct" "$(fmt_mb "$size")" "$total_mb" "$(fmt_mb $(( size * 5 / iter )))" >&2
      sleep 0.2
    done
    wait "$pid" || rc=$?
    trap - INT TERM
    if [ "$rc" -ne 0 ]; then printf '\n' >&2; return "$rc"; fi
    bar=$(printf '%*s' "$width" '' | tr ' ' '#')
    [ "$iter" -gt 0 ] || iter=1
    printf '\r  %s 100%%  %s/%s MB  %6s MB/s\n' \
      "$bar" "$total_mb" "$total_mb" "$(fmt_mb $(( total * 5 / iter )))" >&2
  else
    curl -fsSL --proto '=https' --tlsv1.2 -o "$out" "$final"
  fi
}

echo "supa: installing $target ($VERSION) -> $BIN_DIR/supa"
mkdir -p "$BIN_DIR"
tmp="$(mktemp)"
echo "supa: downloading..."
if ! download "$tmp" "$url"; then
  echo "supa: download failed ($url)" >&2
  echo "     Is a release published yet? See https://github.com/$REPO/releases" >&2
  rm -f "$tmp"; exit 1
fi

# Verify the download against SHA256SUMS.txt. Fail CLOSED: if we can't verify,
# refuse to install (override deliberately with SUPA_SKIP_CHECKSUM=1).
if [ "${SUPA_SKIP_CHECKSUM:-}" = "1" ]; then
  echo "supa: SUPA_SKIP_CHECKSUM=1 — skipping checksum verification" >&2
else
  sums="$(curl -fsSL --proto '=https' --tlsv1.2 "$sums_url" 2>/dev/null || true)"
  expected="$(printf '%s\n' "$sums" | awk -v f="supa-$target" '$2 == f {print $1}')"
  if [ -z "$expected" ]; then
    echo "supa: cannot verify download — no SHA256SUMS entry for supa-$target." >&2
    echo "     Refusing to install unverified. Override with SUPA_SKIP_CHECKSUM=1." >&2
    rm -f "$tmp"; exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  fi
  if [ "$actual" != "$expected" ]; then
    echo "supa: checksum mismatch for supa-$target — aborting" >&2
    rm -f "$tmp"; exit 1
  fi
  echo "supa: checksum verified"
fi

chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/supa"

# Seed a starter registry if the user has none yet (never overwrites).
cfg="${SUPA_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/supa}"
if [ ! -f "$cfg/supa.registry" ]; then
  mkdir -p "$cfg"
  curl -fsSL --proto '=https' --tlsv1.2 \
    "https://raw.githubusercontent.com/$REPO/main/examples/supa.registry.example" \
    -o "$cfg/supa.registry" 2>/dev/null || true
  [ -f "$cfg/supa.registry" ] && echo "supa: seeded a starter registry at $cfg/supa.registry (edit it)"
fi

echo "supa: installed. Next:"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "  • add $BIN_DIR to your PATH" ;;
esac
echo "  • edit your projects into $cfg/supa.registry"
echo "  • run: supa ls   (then: supa help)"
