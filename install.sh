#!/usr/bin/env bash
# AOS installer — https://github.com/albsugy/aos
#
#   curl -fsSL https://raw.githubusercontent.com/albsugy/aos/main/install.sh | bash
#
# Installs the compiled release artifact: download → checksum verify → unpack →
# symlink. No git, no npm, no source code on the machine.
#
# Overrides:
#   AOS_VERSION      release tag to install, e.g. v0.4.0     (default: latest)
#   AOS_INSTALL_DIR  where the app lives                     (default: ~/.local/share/aos)
#   AOS_BIN_DIR      where the symlink goes                  (default: ~/.local/bin)
#   AOS_TARBALL_URL  direct tarball URL (mirrors / testing); checksum fetched from <url>.sha256
#   AOS_FROM_SOURCE  =1 to clone and build from source instead (contributors; needs git + npm)
#   AOS_REPO_URL     source-mode repo URL   (default: https://github.com/albsugy/aos.git)
#   AOS_REF          source-mode branch/tag (default: main)
set -euo pipefail

REPO="albsugy/aos"
REPO_URL="${AOS_REPO_URL:-https://github.com/$REPO.git}"
INSTALL_DIR="${AOS_INSTALL_DIR:-$HOME/.local/share/aos}"
BIN_DIR="${AOS_BIN_DIR:-$HOME/.local/bin}"
VERSION="${AOS_VERSION:-latest}"
REF="${AOS_REF:-main}"
FROM_SOURCE="${AOS_FROM_SOURCE:-0}"

info()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar  >/dev/null 2>&1 || fail "tar is required."
command -v node >/dev/null 2>&1 || fail "Node.js >= 22 is required. Install from https://nodejs.org and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js >= 22 required (found $(node -v))."
ok "Prerequisites: node $(node -v)"

# A git checkout at the install path is a dev install — don't clobber it.
if [ -d "$INSTALL_DIR/.git" ] && [ "$FROM_SOURCE" != "1" ]; then
  fail "Found a source checkout at $INSTALL_DIR — update it with 'git pull', or remove it to switch to release installs."
fi

if [ "$FROM_SOURCE" = "1" ]; then
  # --- contributor path: clone + build ---------------------------------------
  command -v git >/dev/null 2>&1 || fail "git is required for source installs."
  command -v npm >/dev/null 2>&1 || fail "npm is required for source installs."
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating source checkout"
    git -C "$INSTALL_DIR" pull --ff-only -q
  else
    info "Cloning $REPO_URL (ref: $REF)"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone -q --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  fi
  info "Building"
  ( cd "$INSTALL_DIR" && npm ci --no-fund --no-audit --loglevel=error >/dev/null && npm run build >/dev/null )
else
  # --- standard path: release artifact ---------------------------------------
  if [ -n "${AOS_TARBALL_URL:-}" ]; then
    TARBALL_URL="$AOS_TARBALL_URL"
  elif [ "$VERSION" = "latest" ]; then
    TARBALL_URL="https://github.com/$REPO/releases/latest/download/aos.tar.gz"
  else
    TARBALL_URL="https://github.com/$REPO/releases/download/$VERSION/aos.tar.gz"
  fi

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  info "Downloading $TARBALL_URL"
  curl -fsSL -o "$TMP/aos.tar.gz" "$TARBALL_URL" || fail "Download failed."
  curl -fsSL -o "$TMP/aos.tar.gz.sha256" "$TARBALL_URL.sha256" || fail "Checksum download failed."

  (
    cd "$TMP"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c aos.tar.gz.sha256 >/dev/null 2>&1
    else
      shasum -a 256 -c aos.tar.gz.sha256 >/dev/null 2>&1
    fi
  ) || fail "Checksum verification FAILED — refusing to install."
  ok "Checksum verified"

  mkdir "$TMP/unpack"
  tar -xzf "$TMP/aos.tar.gz" -C "$TMP/unpack"
  [ -f "$TMP/unpack/dist/aos.mjs" ] || fail "Artifact is malformed (dist/aos.mjs missing)."
  [ -d "$TMP/unpack/assets" ]      || fail "Artifact is malformed (assets/ missing)."

  rm -rf "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  mv "$TMP/unpack" "$INSTALL_DIR"
  ok "Installed release artifact to $INSTALL_DIR"
fi

# --- link the compiled bundle --------------------------------------------------
[ -f "$INSTALL_DIR/dist/aos.mjs" ] || fail "Compiled bundle missing at $INSTALL_DIR/dist/aos.mjs."
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
VERSION_OUT="$("$BIN_DIR/aos" version 2>/dev/null || true)"
case "$VERSION_OUT" in
  aos*) ok "Installed: $VERSION_OUT" ;;
  *) fail "Install verification failed — try running: node $INSTALL_DIR/dist/aos.mjs version" ;;
esac

cat <<'EOF'

Next steps:
  cd <your repo> && aos init     # register the project, install skills + hooks
  aos status                     # see all projects and runs
  aos console                    # local dashboard at http://127.0.0.1:4560

Docs: https://albsugy.github.io/aos/docs.html
EOF
