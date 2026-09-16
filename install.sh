#!/usr/bin/env bash
# Installs forgebench-session-reviewer from this repo's GitHub Releases.
# Usage: curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/install.sh | bash
set -euo pipefail

REPO="seedlinglabs/forgebench-cli"
BIN_NAME="forgebench-session-reviewer"
INSTALL_DIR="${FORGEBENCH_INSTALL_DIR:-$HOME/.local/bin}"
# stable (default) = latest non-prerelease. preview = latest develop build.
CHANNEL="${FORGEBENCH_CHANNEL:-stable}"

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }
need curl
need uname
[ "${FORGEBENCH_CHANNEL:-stable}" = "preview" ] && need python3

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) die "unsupported OS: $os (this installer supports macOS and Linux; use install.ps1 on Windows)" ;;
esac

case "$arch" in
  arm64|aarch64) target_arch="arm64" ;;
  x86_64|amd64) target_arch="x64" ;;
  *) die "unsupported CPU architecture: $arch" ;;
esac

# Intel Mac: only an arm64 build is published (see the workflow for why).
# Rosetta 2 -- present by default on every Intel Mac -- runs it transparently.
if [ "$platform" = "darwin" ] && [ "$target_arch" = "x64" ]; then
  log "No Intel Mac build published; using the arm64 build under Rosetta 2 instead."
  target_arch="arm64"
fi

asset="${BIN_NAME}-${platform}-${target_arch}"
log "Detected ${platform}/${target_arch} -> looking for asset '${asset}'"

case "$CHANNEL" in
  stable)
    api_url="https://api.github.com/repos/${REPO}/releases/latest"
    release_json="$(curl -fsSL "$api_url")" || die "could not reach GitHub releases API for ${REPO}"
    tag="$(printf '%s' "$release_json" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
    ;;
  preview)
    # /releases/latest ignores prereleases by design, so the newest preview
    # build has to come from the full list instead (already newest-first).
    api_url="https://api.github.com/repos/${REPO}/releases"
    release_json="$(curl -fsSL "$api_url")" || die "could not reach GitHub releases API for ${REPO}"
    tag="$(printf '%s' "$release_json" | python3 -c '
import json, sys
releases = json.load(sys.stdin)
preview = next((r["tag_name"] for r in releases if r.get("prerelease")), None)
print(preview or "")
')"
    ;;
  *)
    die "unknown FORGEBENCH_CHANNEL '${CHANNEL}' (expected 'stable' or 'preview')"
    ;;
esac
[ -n "$tag" ] || die "could not determine the ${CHANNEL} release tag from ${api_url}"
log "Using ${CHANNEL} release: ${tag}"

download_url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
checksums_url="https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

log "Downloading ${asset}..."
curl -fsSL "$download_url" -o "$tmp_dir/$asset" \
  || die "no build for ${platform}/${target_arch} in release ${tag} (expected ${download_url})"

log "Verifying checksum..."
curl -fsSL "$checksums_url" -o "$tmp_dir/SHA256SUMS" \
  || die "could not fetch SHA256SUMS for release ${tag}"

expected="$(grep " ${asset}\$" "$tmp_dir/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || die "no checksum entry for ${asset} in SHA256SUMS"

if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp_dir/$asset" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp_dir/$asset" | awk '{print $1}')"
else
  die "neither shasum nor sha256sum is available to verify the download"
fi

[ "$expected" = "$actual" ] || die "checksum mismatch for ${asset} (expected ${expected}, got ${actual}) -- refusing to install"

mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp_dir/$asset" "$INSTALL_DIR/$BIN_NAME"

log "Installed ${BIN_NAME} ${tag} to ${INSTALL_DIR}/${BIN_NAME}"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    log ""
    log "${INSTALL_DIR} is not on your PATH. Add this to your shell profile:"
    log "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

log ""
log "Run '${BIN_NAME} login --sso' to get started."
