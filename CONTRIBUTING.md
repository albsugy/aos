# Contributing to AOS

Thanks for helping operate AI agents like professionals. AOS is small,
dependency-light, and file-based on purpose — contributions that keep it that
way are the most welcome.

## Scope — what this repo is

This repository is the **open-source, local-first core**: the file spec, the
`aos` CLI, the Claude Code skills and hooks, and the local console. It is
MIT-licensed and runs entirely on your machine.

The hosted, team/organization knowledge-sharing platform that builds *on top of*
this spec (shared workspaces, sync, org-wide audit) is a separate, closed-source
product. Please keep PRs within the local-first core; proposals that assume a
server or multi-tenant backend are out of scope here.

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
- **Both test suites pass**, on macOS and Linux, Node 22 and 24.
- **`shellcheck` is clean** for `install.sh`, `test/smoke.sh`, and
  `scripts/release.sh`.

The smoke suite ([`test/smoke.sh`](test/smoke.sh)) is the contract — new
behavior should come with an assertion there. There is no separate unit
framework; keep tests as end-to-end shell checks against an isolated
`AOS_HOME`.

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
