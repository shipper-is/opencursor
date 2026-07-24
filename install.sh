#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${OPEN_CURSOR_REPO:-https://github.com/shipper-is/opencursor.git}"
REPO_REF="${OPEN_CURSOR_REF:-main}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$1" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || die "$2"
}

# Resolves the Cursor CLI, falling back to the binary shipped inside the app
# bundle when it has not been added to PATH from the command palette.
find_cursor() {
  if command -v cursor >/dev/null 2>&1; then
    command -v cursor
    return 0
  fi
  local candidate
  for candidate in \
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "/usr/share/cursor/bin/cursor" \
    "/opt/cursor/bin/cursor" \
    "$HOME/.local/share/cursor/bin/cursor" \
    "/c/Program Files/Cursor/resources/app/bin/cursor" \
    "$LOCALAPPDATA/Programs/cursor/resources/app/bin/cursor"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

node_major() {
  node -p 'process.versions.node.split(".")[0]'
}

print_next_steps() {
  local provider found=""
  for provider in ngrok cloudflared; do
    if command -v "$provider" >/dev/null 2>&1; then
      found="$provider"
      break
    fi
  done
  if [ -z "$found" ]; then
    warn "Neither ngrok nor cloudflared was found on PATH. Install one before starting the OpenCursor proxy."
  fi

  cat <<'EOF'

Open Cursor Models is installed.

Next steps:
  1. Restart Cursor, or reload the window.
  2. Run "Open Cursor Models: Open Models Setup" from the command palette,
     or click "Custom Models" in the status bar.
  3. Add your models, start the proxy, then copy the Base URL and proxy key
     into Cursor Settings -> Models.

EOF
}

CURSOR_BIN="$(find_cursor)" || die "Could not find the Cursor CLI. Open Cursor, run 'Shell Command: Install cursor command in PATH' from the command palette, then run this script again."
info "Using Cursor CLI at $CURSOR_BIN"

info "Checking build requirements"
require git "git is required. Install it and run this script again."
require node "Node.js 20 or newer is required. Install it from https://nodejs.org and run this script again."
require npm "npm is required. It ships with Node.js."

if [ "$(node_major)" -lt 20 ]; then
  die "Node.js 20 or newer is required, found $(node -v)."
fi

# When piped from curl there is no checkout to build from, so clone one.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  SOURCE_DIR="$SCRIPT_DIR"
  info "Building from $SOURCE_DIR"
else
  SOURCE_DIR="$(mktemp -d)"
  trap 'rm -rf "$SOURCE_DIR"' EXIT
  info "Cloning $REPO_URL"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SOURCE_DIR" >/dev/null 2>&1 \
    || die "Failed to clone $REPO_URL at ref $REPO_REF. Set OPEN_CURSOR_REPO or OPEN_CURSOR_REF to override."
fi

cd "$SOURCE_DIR"

info "Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund >/dev/null
else
  npm install --no-audit --no-fund >/dev/null
fi

VERSION="$(node -p 'require("./package.json").version')"
VSIX="$(node -p 'var p=require("./package.json"); p.name + "-" + p.version + ".vsix"')"

info "Packaging extension v$VERSION"
rm -f "$VSIX"
npm run package >/dev/null

if [ ! -f "$VSIX" ]; then
  # vsce derives the filename from the manifest, so fall back to whatever it
  # just wrote rather than failing on a name mismatch.
  VSIX="$(ls -t ./*.vsix 2>/dev/null | head -n 1 || true)"
  [ -n "$VSIX" ] && [ -f "$VSIX" ] || die "Packaging finished but no .vsix file was created. Run 'npm run package' directly to see the error."
fi

EXTENSION_ID="$(node -p 'var p=require("./package.json"); p.publisher + "." + p.name')"

# Earlier releases shipped under different publisher/name pairs. Leaving them
# installed means two copies racing for the same proxy port and commands.
for stale in open-cursor.open-cursor-models shipper-is.open-cursor-models; do
  if [ "$stale" != "$EXTENSION_ID" ] && "$CURSOR_BIN" --list-extensions 2>/dev/null | grep -qx "$stale"; then
    info "Removing superseded extension $stale"
    "$CURSOR_BIN" --uninstall-extension "$stale" >/dev/null 2>&1 || warn "Could not remove $stale. Uninstall it from the Extensions pane."
  fi
done

info "Installing extension into Cursor"
"$CURSOR_BIN" --install-extension "$VSIX" --force

print_next_steps
