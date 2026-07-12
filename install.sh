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
  url="https://github.com/$REPO/releases/latest/download/supa-$target"
else
  url="https://github.com/$REPO/releases/download/$VERSION/supa-$target"
fi

echo "supa: installing $target ($VERSION) -> $BIN_DIR/supa"
mkdir -p "$BIN_DIR"
tmp="$(mktemp)"
if ! curl -fSL --proto '=https' --tlsv1.2 "$url" -o "$tmp"; then
  echo "supa: download failed ($url)" >&2
  echo "     Is a release published yet? See https://github.com/$REPO/releases" >&2
  rm -f "$tmp"; exit 1
fi
chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/supa"

# Seed a starter registry if the user has none yet (never overwrites).
cfg="${SUPA_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/supa}"
if [ ! -f "$cfg/supa.registry" ]; then
  mkdir -p "$cfg"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/main/supa.registry.example" \
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
