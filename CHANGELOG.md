# Changelog

## Unreleased

Prepared the repository to be public.

- **Source-install URL is HTTPS**, not SSH — `AOS_FROM_SOURCE=1` and the
  documented `git clone` now work for everyone, not just those with push access.
- **npm provenance enabled** (`publishConfig.provenance: true`). Releases from
  this version onward carry a signed attestation tracing the bundle back to this
  repo's CI. Requires a public repo — release only after making it public.
- **Bundled-dependency licenses attributed.** Added `THIRD-PARTY-LICENSES.md`
  crediting the inlined `yaml` (ISC), and switched the build to esbuild
  `legalComments: external` so dependency license banners are preserved.
- **Package metadata:** added `homepage` and `bugs` fields.
- **Governance:** added `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  issue/PR templates, Dependabot config, and README badges.
- **`aos update` help text** no longer claims `git pull` for release installs
  (stale since 0.7.1).

## 0.7.2 — 2026-07-05

Packaging + a cleaner network-access surface.

- **The compiled CLI makes no network requests.** `aos update` used to `fetch`
  the npm registry to check for a newer version (flagged by Socket.dev on 0.7.1).
  That check was redundant — the local `install.sh` already resolves the latest
  version from the registry and verifies its sha-512. `aos update` now just runs
  that installer, passing the running version so it no-ops when already current.
  All outbound access lives in one place (the installer); `dist/aos.mjs` calls no
  `fetch` and reaches no host.
- **Fixes "EntryPointError" from package analyzers.** `package.json` declared
  only `bin` (AOS is a CLI), so tools that resolve an entry point couldn't find
  one. Added `main` and an `exports` map pointing at the compiled bundle.
- **Importing the package no longer runs the CLI.** `dist/aos.mjs` now runs its
  command dispatch only when it is the process entry point (resolved via realpath
  so the `aos` launcher symlink and npm's bin shim still count); imported instead,
  it just exposes `main` and has no side effects — notably it no longer creates
  `~/.aos` on an importer's machine. Source and compiled invocation, including via
  symlink, are unchanged (verified in the smoke suite).

## 0.7.1 — 2026-07-05

Security: harden `aos update` against remote-script execution.

- **No more `curl … install.sh | bash`.** The self-update path used to fetch a
  fresh installer from a CDN and pipe it straight into a shell — a supply-chain
  risk (a compromised CDN could serve a malicious script) flagged by Socket.dev
  on 0.7.0. `aos update` now runs the `install.sh` that shipped *inside the
  already-integrity-verified install* on disk, via `execFileSync('bash', [path])`
  — no network-fetched script is executed, and no string is interpolated into a
  shell. The installer still downloads the new tarball and verifies the
  registry's sha-512 hash before swapping it in, so the update itself stays
  integrity-checked. Falls back to a printed `npm i -g` instruction if the local
  installer is somehow absent.
- Smoke suite gains a regression guard asserting the compiled bundle never pipes
  into a shell.

## 0.7.0 — 2026-07-05

Console redesign: from a single page to a proper multi-screen app.

- **Screens + navigation:** sidebar (projects with needs-you badges and live-run
  dots), breadcrumbs, hash routing — Overview → Project → Run; Esc walks back up.
- **Overview:** fleet KPIs (projects, need-you, active runs, tokens incl. cache),
  decision queue, per-project cards with leverage bars and state counts.
- **Project screen:** runs table with state filter chips + search, tokens-per-session
  sparkline, project memory (context pack / decisions / learnings, rendered), policy
  digest (plan gate, rule counts, contracts), playbooks.
- **Run screen:** full page replacing the drawer — pipeline stage strip
  (intake → plan → implement → verify → package), plan-approval chip, tabbed
  Outcome / Verification / Audit / Ticket / Plan with safe markdown rendering
  (tables, task lists, fenced code), audit timeline with event filters, copyable
  run folder path.
- **New API:** read-only `/api/project` (memory, policy digest, session series);
  `/api/run` now includes the run folder path. Same localhost + safe-id guards.
- **Visual design ("The Ledger"):** warm paper-and-ink theme with serif display
  type, monospace figures, earthy semantic status colors (olive/clay/ochre/teal)
  replacing the generic dark-dashboard look; hairline rules over boxed cards,
  status dot+label tags, a ledger-style KPI strip, a paper-grain texture, one
  entrance reveal on navigation, and a warm-charcoal `prefers-color-scheme: dark`
  counterpart. Still one self-contained file, no external fonts or assets.

## 0.6.0 — 2026-07-04

Guardrail hardening + concurrency/attribution fixes (from the first external-style review).

- **File writes are gated:** `PreToolUse` now covers `Write`/`Edit`/`MultiEdit`/`NotebookEdit`,
  not just Bash. Built-in protections: `.claude/settings.json`, `.git/hooks/`, and AOS's own
  policy/audit/state files require approval — an agent can no longer rewire or silence its own
  guardrails. User-defined `tiers.protected_paths` globs supported. Re-run `aos init` in each
  repo to pick up the wider hook matcher (`aos doctor` flags stale wiring).
- **Script laundering closed:** shell scripts being written are scanned with the same policy —
  writing `run.sh` containing `git push --force` is denied at write time, not discovered at run time.
- **Structural `rm` check:** catastrophic deletes are parsed token-wise (flag permutations like
  `-fr`/`-Rf`, `sudo` prefixes, `/*` and `$HOME` targets), no longer regex-only.
- **Sharper default patterns:** `--force-with-lease` downgrades from forbidden to gated;
  `+refspec` force-pushes forbidden; `deploy` anchored to invocations (`cat docs/deploy.md`
  no longer trips it).
- **`plan_gate: ask` is enforced, not remembered:** implementation file writes stay gated until
  the human approves via the new `aos run approve` (agent self-approval is itself gated).
- **Run ↔ session binding:** each run binds to the session that started it; audit lines and
  tokens from concurrent sessions in the same repo land in the project log instead of the run.
- **Concurrency safety:** all read-modify-write cycles on `state.json`/`meta.json` go through
  a bounded advisory lock; tmp files for atomic writes are pid-unique.
- **Cache-read token accounting:** cache reads tracked separately in `sessions.jsonl`, run
  meta, and `aos status` — no longer silently dropped.

## 0.5.1 — 2026-07-04

Polish pass: correctness, DX, and release discipline.

- **CLI exit codes:** `run finish`/`run state` with no active run and `find` without a
  query now exit 1 instead of 0 — errors are scriptable.
- **npm README fixed:** the package page no longer links to an unavailable site;
  the npm package page is the public home.
- **Release tooling:** `npm run release -- <patch|minor|major|x.y.z>` — bumps, enforces
  a CHANGELOG entry, builds, runs both test suites, commits, and tags; pushing stays
  deliberate. Documented in RELEASING.md.
- **Workflow hardening:** release fails fast if `package.json` doesn't match the tag;
  CI cancels superseded runs, uses current action versions, and shellchecks all scripts.
- **Package metadata:** declares `os: darwin/linux` honestly; `npm test` now runs both
  source and bundle suites; manual `npm publish` self-verifies via `prepublishOnly`.

## 0.5.0 — 2026-07-04

Public distribution via npm.

- **The npm registry is now the public channel.** The package ships only the compiled
  bundle (`dist/aos.mjs`), the skills/templates (`assets/`), and metadata — no source.
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
contracts, local console, and curl installer.
