#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/shims" "$tmp/home" "$tmp/bin"
cat > "$tmp/shims/uname" <<'SH'
#!/usr/bin/env bash
case "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac
SH
chmod +x "$tmp/shims/uname"
cat > "$tmp/shims/curl" <<'SH'
#!/usr/bin/env bash
exit 22
SH
chmod +x "$tmp/shims/curl"
if HOME="$tmp/home" PATH="$tmp/shims:$PATH" bash "$repo_dir/install.sh" --version test --no-setup >"$tmp/output" 2>&1; then
  echo 'Intel Mac install unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'no build for darwin/x64' "$tmp/output"

cat > "$tmp/fake-forgebench" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  --help) echo 'forgebench setup login logout' ;;
  setup|login) echo "unexpected $1" > "$HOME/auth-started" ;;
esac
SH
chmod +x "$tmp/fake-forgebench"
shasum -a 256 "$tmp/fake-forgebench" | awk '{print $1 "  forgebench-darwin-x64"}' > "$tmp/SHA256SUMS"
cat > "$tmp/shims/curl" <<'SH'
#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = "-o" ]; then output_next=1; continue; fi
  if [ "${output_next:-0}" = 1 ]; then output="$arg"; output_next=0; fi
done
case "$*" in
  *SHA256SUMS*) cp "$TEST_ROOT/SHA256SUMS" "$output" ;;
  *forgebench-darwin-x64*) cp "$TEST_ROOT/fake-forgebench" "$output" ;;
  *) exit 22 ;;
esac
SH
chmod +x "$tmp/shims/curl"
HOME="$tmp/home" TEST_ROOT="$tmp" PATH="$tmp/shims:$PATH" \
  FORGEBENCH_INSTALL_DIR="$tmp/installed" bash "$repo_dir/install.sh" --version test --yes --no-modify-path >"$tmp/output" 2>&1
test -x "$tmp/installed/forgebench"
test ! -e "$tmp/home/auth-started"
grep -q 'Install complete. Run' "$tmp/output"

cat > "$tmp/bin/forgebench" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$tmp/bin/forgebench"
if HOME="$tmp/home" FORGEBENCH_INSTALL_DIR="$tmp/bin" bash "$repo_dir/uninstall.sh" >"$tmp/output" 2>&1; then
  echo 'Uninstall unexpectedly succeeded after CLI cleanup failed' >&2
  exit 1
fi
test -x "$tmp/bin/forgebench"
grep -q 'Binary retained so you can retry' "$tmp/output"
echo 'installer smoke checks passed'
