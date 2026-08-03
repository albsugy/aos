# Contributing to AOS

Thanks for helping operate AI agents like professionals. AOS is small,
dependency-light, and file-based on purpose — contributions that keep it that
way are the most welcome.

## Scope — what this repo is

AOS is a local-first tool: the file spec under `~/.aos`, the `aos` CLI, the
Claude Code skills and hooks, and the local console. It is MIT-licensed and runs
entirely on your machine. Contributions should keep to that shape — files over
platforms, and local-only.

## Development setup

Requires **Node ≥ 22** (`.nvmrc` pins 24). No global tools beyond Node.

```bash
git clone https://github.com/albsugy/aos.git && cd aos
npm ci
npm test          # runs the smoke suite against source AND the compiled bundle
```

Common commands:

| Command | What it does |
|---|---|
| `npm run build` | Rebuilds `dist/aos.mjs` (bundle) and `dist/ui.html` |
| `npm run test:source` | Smoke suite against `bin/aos.js` (source) |
| `npm run test:bundle` | Same suite against `dist/aos.mjs` (compiled) |
| `npm test` | Both of the above |

Run the CLI from source without installing: `node bin/aos.js <command>`.

## The rules CI enforces

- **Rebuild `dist/` with any source change.** If you touch `src/`, `bin/`,
  `assets/`, or the console, run `npm run build` and commit the updated `dist/`
  in the same change. A `dist-freshness` job fails the PR otherwise — the
  committed bundle must match what the source produces.
- **All three suites pass** (`npm test` = unit, source, bundle), on macOS and
  Linux, Node 22 and 24.
- **`shellcheck -x` is clean** for `install.sh`, `test/smoke.sh`,
  `test/lib.sh`, `test/sections/*.sh`, and `scripts/release.sh`.

Two layers, and the split is deliberate:

- **`npm run test:unit`** — `node --test test/unit/*.test.js`, the built-in
  runner, no dependencies. For pure functions with many cases: the policy
  engine's helpers, scope matching, pricing, the review schema, sign-off
  tickets, the registry, the path primitives. Fast enough (well under a second)
  to run on every save.
- **`npm run test:source` / `test:bundle`** — the end-to-end contract. The
  driver `test/smoke.sh` builds an isolated `AOS_HOME` and a throwaway repo,
  then sources `test/sections/*.sh` **in the order listed in `SECTIONS`**.
  That order is part of the fixture: sections read the project and run history
  the earlier ones left behind. Shared helpers live in `test/lib.sh`;
  section-local ones stay in their section.

New behavior needs an assertion in one of them — end-to-end if it crosses a
hook, the CLI, or the filesystem; unit if it's a function you can call. A new
section file must be added to `SECTIONS` in the driver, which fails loudly if
you forget.

## Style

- Match the surrounding code: small modules, no framework, comments that explain
  *why* (especially for anything security- or concurrency-sensitive).
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`,
  `security:`). Keep PRs scoped to one concern.
- Update `CHANGELOG.md` under an `## Unreleased` heading for anything
  user-visible.

## Reporting bugs and security issues

- Bugs and feature requests: open an issue (templates provided).
- Security vulnerabilities: **do not** open a public issue — see
  [SECURITY.md](SECURITY.md).

## Releases

Releasing is maintainer-only and documented in [RELEASING.md](RELEASING.md).
