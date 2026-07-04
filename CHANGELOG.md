# Changelog

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

- **Installs ship a compiled bundle, not source:** `dist/aos.mjs` — single file, all
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
