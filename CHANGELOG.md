# Changelog

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
