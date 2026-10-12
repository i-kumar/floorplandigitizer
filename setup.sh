#!/usr/bin/env bash
# One-shot setup for a fresh clone: installs Node (via nvm) if it's missing or
# too old, installs the project's npm packages, and tells you how to start.
#
#   ./setup.sh          install everything
#   ./setup.sh --dev    install, then start the dev server
#
# macOS / Linux (bash). On Windows: install Node LTS from https://nodejs.org,
# then run `npm install` and `npm run dev` in this folder.
set -euo pipefail
cd "$(dirname "$0")"

NEED_MAJOR=20          # Vite 5 / Vitest 2 need Node 18+; we standardize on 20 LTS
NVM_VERSION="v0.40.1"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }

# nvm's scripts aren't clean under `set -eu`, so relax strict mode around them.
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  set +eu
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  set -eu
}
nvm_run() { set +eu; nvm "$@"; local rc=$?; set -eu; return $rc; }

say "Checking Node.js"
load_nvm
if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NEED_MAJOR" ]; then
  ok "Node $(node -v) found"
else
  if command -v node >/dev/null 2>&1; then
    echo "   Node $(node -v) is too old (need $NEED_MAJOR+)."
  else
    echo "   Node is not installed."
  fi
  if ! command -v nvm >/dev/null 2>&1; then
    say "Installing nvm (Node version manager) into ~/.nvm"
    command -v curl >/dev/null 2>&1 || fail "curl is required to install nvm (on macOS run: xcode-select --install)"
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
    load_nvm
    command -v nvm >/dev/null 2>&1 || fail "nvm did not load; open a new terminal and re-run ./setup.sh"
  fi
  say "Installing Node $NEED_MAJOR LTS with nvm"
  nvm_run install "$NEED_MAJOR"
  nvm_run alias default "$NEED_MAJOR" >/dev/null
  nvm_run use "$NEED_MAJOR" >/dev/null
  ok "Node $(node -v) installed"
  echo "   (New terminals pick it up automatically; this one already has it.)"
fi

say "Installing project packages"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
ok "Packages installed"

say "Checking the install"
npm run -s typecheck && ok "TypeScript OK"
npm test -- --reporter=dot >/dev/null 2>&1 && ok "Unit tests pass" || echo "   (unit tests reported a problem — run 'npm test' to see details)"

cat <<MSG

Ready. Next:
  npm run dev        → opens the tool at http://localhost:5173
  npm run build      → production build in dist/
MSG

if [ "${1:-}" = "--dev" ]; then
  say "Starting the dev server (Ctrl+C to stop)"
  exec npm run dev
fi
