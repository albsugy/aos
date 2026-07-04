#!/usr/bin/env bash
# AOS installer
#
#   curl -fsSL https://cdn.jsdelivr.net/npm/@albsugy/aos/install.sh | bash
#   # or: npm i -g @albsugy/aos
#
# Installs the compiled bundle published on the npm registry: resolve version →
# download tarball → verify registry integrity hash → unpack → symlink.
# No git or npm client needed.
#
# Overrides:
#   AOS_VERSION      version to install, e.g. 0.5.0 or v0.5.0  (default: latest)
#   AOS_INSTALL_DIR  where the app lives                       (default: ~/.local/share/aos)
#   AOS_BIN_DIR      where the symlink goes                    (default: ~/.local/bin)
#   AOS_NPM_PKG      package name                              (default: @albsugy/aos)
#   AOS_NPM_REGISTRY registry base URL                         (default: https://registry.npmjs.org)
#   AOS_TARBALL_URL  direct tarball URL (mirrors / testing); checksum fetched from <url>.sha256
#   AOS_FROM_SOURCE  =1 to clone and build from source (requires repo access, git, npm)
#   AOS_REPO_URL     source-mode repo URL   (default: git@github.com:albsugy/aos.git)
#   AOS_REF          source-mode branch/tag (default: main)
set -euo pipefail

PKG="${AOS_NPM_PKG:-@albsugy/aos}"
REG="${AOS_NPM_REGISTRY:-https://registry.npmjs.org}"
REPO_URL="${AOS_REPO_URL:-git@github.com:albsugy/aos.git}"
INSTALL_DIR="${AOS_INSTALL_DIR:-$HOME/.local/share/aos}"
BIN_DIR="${AOS_BIN_DIR:-$HOME/.local/bin}"
VERSION="${AOS_VERSION:-latest}"
VERSION="${VERSION#v}"
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

unpack_tarball() {
  # npm tarballs nest everything under package/ — strip it; plain tarballs pass through.
  local tarball="$1" dest="$2" first
  mkdir -p "$dest"
  first="$(tar -tzf "$tarball" | head -1)"
  case "$first" in
    package/*) tar -xzf "$tarball" -C "$dest" --strip-components=1 ;;
    *)         tar -xzf "$tarball" -C "$dest" ;;
  esac
}

if [ "$FROM_SOURCE" = "1" ]; then
  # --- contributor path (requires repo access): clone + build ----------------
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
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  if [ -n "${AOS_TARBALL_URL:-}" ]; then
    # --- direct tarball (mirrors / testing): sha256 sidecar verification -----
    info "Downloading $AOS_TARBALL_URL"
    curl -fsSL -o "$TMP/aos.tgz" "$AOS_TARBALL_URL" || fail "Download failed."
    curl -fsSL -o "$TMP/aos.tgz.sha256" "$AOS_TARBALL_URL.sha256" || fail "Checksum download failed."
    EXPECTED="$(awk '{print $1}' "$TMP/aos.tgz.sha256")"
    ACTUAL="$(node -e 'const c=require("crypto"),f=require("fs");console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TMP/aos.tgz")"
    if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
      fail "Checksum verification FAILED — refusing to install."
    fi
    ok "Checksum verified (sha256)"
  else
    # --- standard path: the npm registry --------------------------------------
    META_URL="$REG/$PKG/$VERSION"
    info "Resolving $PKG@$VERSION from $REG"
    META="$(curl -fsSL "$META_URL")" || fail "Could not resolve $PKG@$VERSION — is it published?"
    RESOLVED="$(printf '%s' "$META" | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(m.version||"")')"
    TARBALL="$(printf '%s' "$META" | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((m.dist&&m.dist.tarball)||"")')"
    INTEGRITY="$(printf '%s' "$META" | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((m.dist&&m.dist.integrity)||"")')"
    if [ -z "$RESOLVED" ] || [ -z "$TARBALL" ]; then
      fail "Registry metadata is malformed."
    fi

    info "Downloading $PKG@$RESOLVED"
    curl -fsSL -o "$TMP/aos.tgz" "$TARBALL" || fail "Download failed."

    if [ -n "$INTEGRITY" ]; then
      node -e '
        const crypto = require("crypto"), fs = require("fs");
        const [file, integrity] = process.argv.slice(1);
        const dash = integrity.indexOf("-");
        const algo = integrity.slice(0, dash), expected = integrity.slice(dash + 1);
        const actual = crypto.createHash(algo).update(fs.readFileSync(file)).digest("base64");
        process.exit(actual === expected ? 0 : 1);
      ' "$TMP/aos.tgz" "$INTEGRITY" || fail "Integrity verification FAILED — refusing to install."
      ok "Integrity verified (${INTEGRITY%%-*}, from registry)"
    else
      fail "Registry provided no integrity hash — refusing to install."
    fi
  fi

  unpack_tarball "$TMP/aos.tgz" "$TMP/unpack"
  [ -f "$TMP/unpack/dist/aos.mjs" ] || fail "Artifact is malformed (dist/aos.mjs missing)."
  [ -d "$TMP/unpack/assets" ]      || fail "Artifact is malformed (assets/ missing)."

  rm -rf "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  mv "$TMP/unpack" "$INSTALL_DIR"
  ok "Installed to $INSTALL_DIR"
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

Package: https://www.npmjs.com/package/@albsugy/aos
EOF
