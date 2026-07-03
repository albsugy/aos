#!/usr/bin/env bash
# AOS installer — https://github.com/albsugy/aos
#
#   curl -fsSL https://raw.githubusercontent.com/albsugy/aos/main/install.sh | bash
#
# Overrides:
#   AOS_REPO_URL     git URL to install from   (default: https://github.com/albsugy/aos.git)
#   AOS_INSTALL_DIR  where the app lives       (default: ~/.local/share/aos)
#   AOS_BIN_DIR      where the symlink goes    (default: ~/.local/bin)
set -euo pipefail

REPO_URL="${AOS_REPO_URL:-https://github.com/albsugy/aos.git}"
INSTALL_DIR="${AOS_INSTALL_DIR:-$HOME/.local/share/aos}"
BIN_DIR="${AOS_BIN_DIR:-$HOME/.local/bin}"
REF="${AOS_REF:-main}"   # branch or tag to install, e.g. AOS_REF=v0.2.0

info()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required. Install git and re-run."
command -v node >/dev/null 2>&1 || fail "Node.js >= 22 is required. Install from https://nodejs.org and re-run."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js >= 22 required (found $(node -v))."
ok "Prerequisites: git, node $(node -v)"

# --- fetch or update the app -------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing install found — updating"
  git -C "$INSTALL_DIR" pull --ff-only -q
else
  info "Installing AOS to $INSTALL_DIR (ref: $REF)"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone -q --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
fi

# --- link the compiled bundle ------------------------------------------------
# No dependency install: the repo ships a compiled single-file build with all
# dependencies inlined (dist/aos.mjs), verified against source by CI.
[ -f "$INSTALL_DIR/dist/aos.mjs" ] || fail "Compiled bundle missing at $INSTALL_DIR/dist/aos.mjs — the ref '$REF' may predate compiled releases."
chmod +x "$INSTALL_DIR/dist/aos.mjs"

mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/dist/aos.mjs" "$BIN_DIR/aos"
ok "Linked $BIN_DIR/aos → compiled bundle"

# --- make sure BIN_DIR is on PATH -------------------------------------------
ensure_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
  esac
  local rc=""
  local shell_name
  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh)  rc="$HOME/.zshrc" ;;
    bash) rc="$HOME/.bashrc" ;;
    fish) rc="$HOME/.config/fish/config.fish" ;;
    *)    rc="$HOME/.profile" ;;
  esac
  if [ "$shell_name" = "fish" ]; then
    mkdir -p "$(dirname "$rc")"
    if ! grep -qs "aos installer" "$rc"; then
      printf '\n# added by aos installer\nfish_add_path %s\n' "$BIN_DIR" >> "$rc"
    fi
  else
    if ! grep -qs "aos installer" "$rc"; then
      # shellcheck disable=SC2016  # literal $PATH is intentional — it must expand when the rc runs, not now
      printf '\n# added by aos installer\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
    fi
  fi
  info "Added $BIN_DIR to PATH in $rc — restart your shell or: export PATH=\"$BIN_DIR:\$PATH\""
}
ensure_path

# --- verify ------------------------------------------------------------------
VERSION="$("$BIN_DIR/aos" version 2>/dev/null || true)"
[ -n "$VERSION" ] || fail "Install verification failed — try running: node $INSTALL_DIR/bin/aos.js version"
ok "Installed: $VERSION"

cat <<'EOF'

Next steps:
  cd <your repo> && aos init     # register the project, install skills + hooks
  aos status                     # see all projects and runs
  aos console                    # local dashboard at http://127.0.0.1:4560

Docs: https://albsugy.github.io/aos/docs.html
EOF
