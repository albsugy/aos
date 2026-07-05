# Security policy

AOS installs Claude Code hooks that run on every tool call and reads local
session transcripts to account for tokens. It runs entirely on your machine —
the console binds to `127.0.0.1`, and the CLI itself makes no network requests
(the installer is the only component that reaches the npm registry, and it
verifies the registry's sha-512 integrity hash before installing). We take
reports about any of this seriously.

## Supported versions

Fixes land on the latest published minor. Please reproduce on the current
release (`aos version`; update with `aos update`) before reporting.

| Version | Supported |
|---|---|
| latest `0.7.x` | ✅ |
| older | ❌ (please update) |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: the **Security** tab →
**Report a vulnerability**
(https://github.com/albsugy/aos/security/advisories/new). It opens a private
channel with the maintainer. If that is unavailable to you, open a public issue
that says only "security report — please open a private channel" with no
details, and we will follow up.

Please include: the version, your OS and Node version, reproduction steps, and
the impact you observed. We aim to acknowledge within a few days and to ship a
fix promptly for anything confirmed.

## Threat model, honestly

The policy gates (`policy.yaml`, enforced by the `PreToolUse` hook) are
**accident-protection for well-meaning agents** — the failure mode that actually
happens. They cover the tool paths agents really use (Bash and file writes) and
self-protect AOS's own guardrails, but a deliberately adversarial agent needs
OS-level isolation (containers, sandboxes), which no hook layer can provide.
Pair AOS with sandboxing when you need a hard boundary. Reports that assume this
boundary (e.g. "an agent told to bypass the gate can bypass the gate") are
expected behavior, not vulnerabilities — but reports of the gates failing to
catch an *ordinary* risky action, of AOS state being corruptible by untrusted
input, or of the installer/console being exploitable, are exactly what we want.
