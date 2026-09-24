#!/usr/bin/env bash
# Installs forgebench from this repo's GitHub Releases.
# Usage: curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/install.sh | bash
set -euo pipefail

REPO="seedlinglabs/forgebench-cli"
BIN_NAME="forgebench"
INSTALL_DIR="${FORGEBENCH_INSTALL_DIR:-$HOME/.local/bin}"
# stable (default) = latest non-prerelease. preview = latest develop build.
CHANNEL="${FORGEBENCH_CHANNEL:-stable}"

# Every prompt this script can ask has a flag and an env var that pre-answers
# it, because the fleet entry point is `curl ... | bash -s -- --yes --no-setup`
# and an installer that can only be driven by a human is not one an org can
# roll out. Flags win over env so a one-off override is possible.
ASSUME_YES="${FORGEBENCH_YES:-0}"
NO_MODIFY_PATH="${FORGEBENCH_NO_MODIFY_PATH:-0}"
RUN_SETUP="${FORGEBENCH_NO_SETUP:+0}"; RUN_SETUP="${RUN_SETUP:-1}"
RELEASE_TAG="${FORGEBENCH_RELEASE_TAG:-}"

usage() {
  cat >&2 <<'USAGE'
forgebench installer

  --version <tag>     install a specific release instead of the latest
  --install-dir <dir> where to put the binary (default: ~/.local/bin)
  --no-modify-path    never touch a shell profile
  --no-setup          install only; do not launch guided setup
  --yes               assume yes for every prompt
  -h, --help          this message

Env equivalents: FORGEBENCH_RELEASE_TAG, FORGEBENCH_INSTALL_DIR,
FORGEBENCH_NO_MODIFY_PATH, FORGEBENCH_NO_SETUP, FORGEBENCH_YES.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) RELEASE_TAG="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --no-modify-path) NO_MODIFY_PATH=1; shift ;;
    --no-setup) RUN_SETUP=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
done

# Colors degrade to empty strings on a non-tty, a dumb terminal, or NO_COLOR --
# every call site below stays correct either way, nothing branches on this.
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  BOLD="$(tput bold 2>/dev/null || printf '')"
  DIM="$(tput dim 2>/dev/null || printf '')"
  GREEN="$(tput setaf 2 2>/dev/null || printf '')"
  YELLOW="$(tput setaf 3 2>/dev/null || printf '')"
  RED="$(tput setaf 1 2>/dev/null || printf '')"
  CYAN="$(tput setaf 6 2>/dev/null || printf '')"
  RESET="$(tput sgr0 2>/dev/null || printf '')"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

info()    { printf '%s\n' "${DIM}→${RESET} $*" >&2; }
success() { printf '%s\n' "${GREEN}✓${RESET} $*" >&2; }
warn()    { printf '%s\n' "${YELLOW}!${RESET} $*" >&2; }
die()     { printf '%s\n' "${RED}x${RESET} error: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }
need curl
need uname
[ "${FORGEBENCH_CHANNEL:-stable}" = "preview" ] && need python3

printf '\n%s\n' "${BOLD}${CYAN}forgebench${RESET}${DIM} · installer${RESET}" >&2

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

# Only darwin-arm64, linux-x64 and windows-x64 are published.
fallback_arch=""
if [ "$platform" = "darwin" ] && [ "$target_arch" = "x64" ]; then
  fallback_arch="arm64"
fi
if [ "$platform" = "linux" ] && [ "$target_arch" = "arm64" ]; then
  die "no linux/arm64 build is published yet; build from source or use linux/x64"
fi

asset="${BIN_NAME}-${platform}-${target_arch}"
legacy_asset="forgebench-session-reviewer-${platform}-${target_arch}"
info "Detected ${BOLD}${platform}/${target_arch}${RESET}${DIM} -> looking for asset '${asset}'${RESET}"

diagnose_curl() {
  status="$1"; what="$2"
  case "$status" in
    5) die "could not resolve the proxy for ${what}. Check HTTPS_PROXY." ;;
    6) die "could not resolve host for ${what}. Check DNS or HTTPS_PROXY." ;;
    7) die "connection refused for ${what}. Check your network or HTTPS_PROXY." ;;
    28) die "timed out fetching ${what}. Check your network or HTTPS_PROXY." ;;
    35|60|77) die "TLS verification failed for ${what}. Set SSL_CERT_FILE to your corporate CA if needed." ;;
    *) die "could not fetch ${what} (curl exit ${status})" ;;
  esac
}

if [ -n "$RELEASE_TAG" ]; then
  tag="$RELEASE_TAG"
  info "Using requested release: ${tag}"
else
  case "$CHANNEL" in
    stable) api_url="https://api.github.com/repos/${REPO}/releases/latest" ;;
    preview) api_url="https://api.github.com/repos/${REPO}/releases" ;;
    *) die "unknown FORGEBENCH_CHANNEL '${CHANNEL}' (expected stable or preview)" ;;
  esac
  err_file="$(mktemp)"
  if release_json="$(curl -fsSL "$api_url" 2>"$err_file")"; then
    rm -f "$err_file"
  else
    rc=$?
    rm -f "$err_file"
    diagnose_curl "$rc" "the ${CHANNEL} release list"
  fi
  if [ "$CHANNEL" = "preview" ]; then
    tag="$(printf '%s' "$release_json" | python3 -c 'import json,sys; print(next((r["tag_name"] for r in json.load(sys.stdin) if r.get("prerelease")), ""))')"
  else
    tag="$(printf '%s' "$release_json" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  fi
  [ -n "$tag" ] || die "could not determine the ${CHANNEL} release tag"
  info "Using ${CHANNEL} release: ${tag}"
fi

download_url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
checksums_url="https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# Candidates in preference order: the current name, the pre-1.2 name (so an
# older pinned release still installs), and -- on an Intel Mac -- the arm64
# build under Rosetta. Falling back is normal, not a warning.
candidates="$asset $legacy_asset"
if [ -n "$fallback_arch" ]; then
  candidates="$candidates ${BIN_NAME}-${platform}-${fallback_arch} forgebench-session-reviewer-${platform}-${fallback_arch}"
fi

info "Downloading ${asset}..."
found=""
for candidate in $candidates; do
  url="https://github.com/${REPO}/releases/download/${tag}/${candidate}"
  if curl -fL --progress-bar "$url" -o "$tmp_dir/$candidate" 2>/dev/null; then
    found="$candidate"
    [ "$candidate" = "$asset" ] || info "Using asset ${candidate}"
    case "$candidate" in
      *"-${fallback_arch}") [ -n "$fallback_arch" ] && info "Running the ${fallback_arch} build under Rosetta 2." ;;
    esac
    break
  fi
done
[ -n "$found" ] || die "no build for ${platform}/${target_arch} in release ${tag} (tried: ${candidates})"
asset="$found"
download_url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

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
success "Checksum verified"

mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp_dir/$asset" "$INSTALL_DIR/$BIN_NAME"
success "Installed ${BOLD}${BIN_NAME} ${tag}${RESET} -> ${INSTALL_DIR}/${BIN_NAME}"

# Appends a PATH export to the shell config forgebench's own interactive
# shell resolves to ($SHELL), not the one running this installer (bash even
# on a zsh user's machine, since that is what curl | bash always launches).
path_rc_file() {
  case "$(basename "${SHELL:-}")" in
    zsh) printf '%s' "$HOME/.zshrc" ;;
    bash)
      if [ "$platform" = "darwin" ] && [ -f "$HOME/.bash_profile" ]; then
        printf '%s' "$HOME/.bash_profile"
      elif [ "$platform" = "darwin" ] && [ ! -f "$HOME/.bashrc" ]; then
        printf '%s' "$HOME/.bash_profile"
      else
        printf '%s' "$HOME/.bashrc"
      fi
      ;;
    fish) printf '%s' "$HOME/.config/fish/config.fish" ;;
    *) printf '' ;;
  esac
}

append_path_line() {
  rc_file="$1"
  marker="# Added by the forgebench installer"
  if [ -f "$rc_file" ] && grep -qF "$marker" "$rc_file" 2>/dev/null; then
    return 0
  fi
  mkdir -p "$(dirname "$rc_file")"
  if [ "$(basename "$rc_file")" = "config.fish" ]; then
    printf '\n%s\nset -gx PATH %s $PATH\n' "$marker" "$INSTALL_DIR" >> "$rc_file"
  else
    printf '\n%s\nexport PATH="%s:$PATH"\n' "$marker" "$INSTALL_DIR" >> "$rc_file"
  fi
}

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;; # already on PATH, nothing to do
  *)
    rc_file="$(path_rc_file)"
    if [ "$NO_MODIFY_PATH" = "1" ]; then
      info "${INSTALL_DIR} is not on your PATH (--no-modify-path). Add:"
      info "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    elif [ "$ASSUME_YES" = "1" ] && [ -n "$rc_file" ]; then
      append_path_line "$rc_file"
      success "Added to ${rc_file}"
    elif [ -r /dev/tty ] && [ -t 2 ] && [ -n "$rc_file" ]; then
      printf '%s' "${CYAN}?${RESET} Add ${INSTALL_DIR} to PATH via ${rc_file}? ${BOLD}[Y/n]${RESET} " > /dev/tty
      IFS= read -r reply < /dev/tty || reply=""
      case "$reply" in
        [Nn]*)
          warn "Skipped. Add this to your shell profile yourself:"
          warn "  export PATH=\"${INSTALL_DIR}:\$PATH\""
          ;;
        *)
          append_path_line "$rc_file"
          success "Added to ${rc_file} -- restart your terminal or run: source ${rc_file}"
          ;;
      esac
    else
      warn "${INSTALL_DIR} is not on your PATH. Add this to your shell profile:"
      warn "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    fi
    ;;
esac

# Distinguish "the binary does not run" from "this build has no setup".
# The old single `if` collapsed both into the same reassuring message, so a
# wrong-arch or quarantined binary was reported as merely out of date.
if ! help_text="$("$INSTALL_DIR/$BIN_NAME" --help 2>&1)"; then
  warn "Installed, but '${BIN_NAME} --help' did not run successfully:"
  printf '%s\n' "$help_text" | head -3 >&2
  warn "Run '${BIN_NAME} doctor' once it runs, or reinstall for your platform."
elif ! printf '%s' "$help_text" | grep -qE '(^|[[:space:]{,])setup([[:space:]},]|$)'; then
  warn "Release ${tag} has no guided setup. Use '${BIN_NAME} login --sso' then '${BIN_NAME} run --all --push', or install a newer release with setup."
elif [ "$RUN_SETUP" = "0" ]; then
  info "Install complete (--no-setup). Run '${BIN_NAME} setup' when ready."
elif [ -r /dev/tty ] && [ -t 2 ]; then
  info "Starting guided ${BOLD}forgebench${RESET}${DIM} setup...${RESET}"
  # `|| true`: setup exiting non-zero (nothing selected, not signed in) is a
  # state the user can resolve later. It must not make a completed install
  # report failure -- under `set -e` this was the last statement, so a UX
  # dead-end made the whole `curl | bash` exit non-zero.
  "$INSTALL_DIR/$BIN_NAME" setup </dev/tty || warn "Setup did not finish. Re-run: ${BIN_NAME} setup"
else
  info "Install complete. Run '${BIN_NAME} setup' in an interactive terminal to finish setup."
fi
