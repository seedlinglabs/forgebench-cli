#!/usr/bin/env bash
# Removes forgebench: hooks, scheduled run, credentials, config, binary, PATH line.
# Usage: curl -fsSL https://raw.githubusercontent.com/seedlinglabs/forgebench-cli/main/uninstall.sh | bash
set -euo pipefail

BIN_NAME="forgebench"
INSTALL_DIR="${FORGEBENCH_INSTALL_DIR:-$HOME/.local/bin}"

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  BOLD="$(tput bold 2>/dev/null || printf '')"
  DIM="$(tput dim 2>/dev/null || printf '')"
  GREEN="$(tput setaf 2 2>/dev/null || printf '')"
  YELLOW="$(tput setaf 3 2>/dev/null || printf '')"
  RESET="$(tput sgr0 2>/dev/null || printf '')"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RESET=""
fi
info()    { printf '%s\n' "${DIM}→${RESET} $*" >&2; }
success() { printf '%s\n' "${GREEN}✓${RESET} $*" >&2; }
warn()    { printf '%s\n' "${YELLOW}!${RESET} $*" >&2; }

printf '\n%s\n' "${BOLD}forgebench${RESET}${DIM} · uninstaller${RESET}" >&2

# Let the CLI remove what only it knows about (hooks live inside OTHER tools'
# config files, and blindly deleting those would take the user's own hooks
# with them). Only then remove the binary -- a process cannot reliably delete
# itself, which is why this is a separate script rather than a subcommand.
bin_path="$INSTALL_DIR/$BIN_NAME"

if [ -x "$bin_path" ]; then
  info "Removing hooks, schedule and stored credentials..."
  "$bin_path" uninstall || warn "The CLI reported a problem; continuing."
  rm -f "$bin_path" && success "Removed $bin_path"
else
  warn "No $BIN_NAME binary found; removing the PATH line only."
fi

# Strip the marker block the installer appended. Matches the two lines it
# writes and nothing else, so a profile edited by hand is left intact.
marker="# Added by the forgebench installer"
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.config/fish/config.fish"; do
  [ -f "$rc" ] || continue
  grep -qF "$marker" "$rc" 2>/dev/null || continue
  tmp="$(mktemp)"
  # The installer appends exactly two lines: the marker and ONE export. Skip
  # precisely that -- an off-by-one here silently deletes whatever the user
  # happened to write next in their own profile.
  awk -v m="$marker" '
    $0 == m { skip = 1; next }
    skip > 0 { skip--; next }
    { print }
  ' "$rc" > "$tmp"
  cat "$tmp" > "$rc"
  rm -f "$tmp"
  success "Removed the PATH line from $rc"
done

printf '\n%s\n' "${GREEN}forgebench has been removed.${RESET}" >&2
