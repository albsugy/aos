# Changelog

## 0.5.1 — 2026-07-04

Polish pass: correctness, DX, and release discipline.

- **CLI exit codes:** `run finish`/`run state` with no active run and `find` without a
  query now exit 1 instead of 0 — errors are scriptable.
- **npm README fixed:** the package page no longer links to the repository's
  unavailable site; the npm package page is the public home.
- **Release tooling:** `npm run release -- <patch|minor|major|x.y.z>` — bumps, enforces
  a CHANGELOG entry, builds, runs both test suites, commits, and tags; pushing stays
  deliberate. Documented in RELEASING.md.
- **Workflow hardening:** release fails fast if `package.json` doesn't match the tag;
  CI cancels superseded runs, uses current action versions, and shellchecks all scripts.
- **Package metadata:** declares `os: darwin/linux` honestly; `npm test` now runs both
  source and bundle suites; manual `npm publish` self-verifies via `prepublishOnly`.

## 0.5.0 — 2026-07-04

Public distribution via npm; the compiled single-file bundle.

- **The npm registry is now the public channel.** The package ships only the compiled
  bundle (`dist/aos.mjs`), the skills/templates (`assets/`), and metadata.
  `bin` points at the bundle; `yaml` moved to devDependencies (it's inlined).
- **Two install methods, one artifact:** `npm i -g @albsugy/aos`, or
  `curl -fsSL https://cdn.jsdelivr.net/npm/@albsugy/aos/install.sh | bash` — the
  installer ships inside the package and is served by the jsDelivr CDN.
- **The curl installer resolves versions from the npm registry** and verifies the
  registry's sha-512 integrity hash before unpacking. `AOS_VERSION` pins an npm
  version; `AOS_NPM_REGISTRY` supports mirrors; direct-URL and from-source modes remain.
- **`aos update`** on release installs checks the npm registry (was GitHub Releases).
- **Release workflow** publishes to npm on `v*` tags when the `NPM_TOKEN` secret is set
  (skips with a notice otherwise) and attaches the npm-pack tarball to the GitHub release.

## 0.4.0 — 2026-07-04

Standard package distribution: release artifacts instead of source clones.

- **Installs no longer clone the repo.** The installer downloads `aos.tar.gz` from
  GitHub Releases (runtime only: `dist/` + `assets/` + metadata, ~150 KB), verifies
  its **SHA-256 checksum**, unpacks, and links. git is no longer required to install.
- **Release workflow** builds and attaches `aos.tar.gz` + `aos.tar.gz.sha256` to every
  `v*` release after re-running both smoke suites.
- **`aos update`** on release installs checks the latest GitHub release and only
  downloads when newer; dev checkouts keep the `git pull` path.
- **`AOS_VERSION=vX.Y.Z`** pins installs to a release; `AOS_TARBALL_URL` supports
  mirrors/testing; `AOS_FROM_SOURCE=1` clones and builds for contributors.
- Installer refuses to overwrite a dev checkout at the install path, and `aos doctor`
  now reports the install mode (release artifact vs dev checkout) and verifies layout.

## 0.3.1 — 2026-07-04

CI reliability + release infrastructure.

- **Fixed flaky console-UI smoke check** — `curl | grep -q` under `pipefail` races
  (grep exits on first match → curl gets EPIPE → pipeline fails despite a match);
  surfaced on ubuntu CI. Console checks now capture responses and match without pipes.
- **Dist-freshness gate hardened:** also fails on *untracked* files in `dist/`,
  which `git diff` alone cannot see.
- **Release workflow:** pushing a `v*` tag re-verifies both suites and creates a
  GitHub Release with generated notes.
- **npm publish readiness:** `files` allowlist, `publishConfig.access=public`,
  `prepublishOnly` build.

## 0.3.0 — 2026-07-04

Compiled installs.

- **Installs ship a compiled single-file bundle:** `dist/aos.mjs` — single file, all
  dependencies inlined, minified, built by esbuild (`npm run build`) and committed;
  the installer links it directly. No npm download at install time.
- **Node ≥ 22 required** (was 18) — installer, `engines`, `aos doctor`, docs, and CI updated.
- **CI:** smoke suite runs against both source and the compiled bundle on node 22/24;
  a dist-freshness job fails if `dist/` wasn't rebuilt with source changes.
- **`aos update`** in compiled installs no longer touches npm at all — the pull delivers the new bundle.
- Source entry restructured: CLI moved to `src/cli.js`; `bin/aos.js` is a thin shim for dev/npm use.

## 0.2.0 — 2026-07-04

Production hardening.

- **Reproducible installs:** committed `package-lock.json`; installer and `aos update` use `npm ci` when the lockfile is present.
- **Pinned installs:** `AOS_REF=<tag|branch>` selects what the installer checks out (default `main`).
- **Console security:** project/run ids validated against path traversal; requests with a non-localhost `Host` header are refused (DNS-rebinding protection); friendly error when the port is taken.
- **Corruption resilience:** a corrupt `registry.yaml` degrades reads with a warning and blocks writes instead of clobbering; JSON state files are written atomically.
- **`aos doctor`:** diagnoses node version, app install, dependencies, `AOS_HOME`, registry integrity, dangling repo paths, and the current repo's hook wiring (including old-format detection).
- **Stable hook launcher** (from 0.1.x fixes): hooks call `$HOME/.local/bin/aos` with a PATH fallback instead of a pinned install path; `aos init` migrates old entries.
- **`aos update`** skips reinstalling dependencies when already up to date.
- **CI:** smoke suite (26 checks) on ubuntu/macos × node 18/20/22, plus shellcheck on the installer.

## 0.1.0 — 2026-07-04

Initial release: file spec (`~/.aos`), policy gates, run lifecycle, audit, Claude Code
skills (`/aos-ticket`, `/aos-verify`, `/aos-learn`, `/aos-ask`) and hooks, verification
contracts, local console, curl installer, landing page and manual.
