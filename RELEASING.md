# Releasing AOS

Maintainer-only. This file is not shipped in the npm package.

## One-time prerequisites

- npm account with publish rights on `@albsugy/aos`
- Trusted publisher configured on npmjs.com (package → Settings → Trusted Publisher):
  GitHub Actions · owner `albsugy` · repo `aos` · workflow `release.yml` · allowed action `npm publish`
- Publishing access set to "Require two-factor authentication and disallow tokens"

## Ship a release

```bash
# 1. write the changelog entry first — the release script refuses without it
$EDITOR CHANGELOG.md            # add "## X.Y.Z — YYYY-MM-DD"

# 2. cut the release (bump + lockfile + build + both test suites + commit + tag)
npm run release -- patch        # or minor / major / an explicit version

# 3. ship — this is the only irreversible step
git push origin main vX.Y.Z
```

The tag push triggers `.github/workflows/release.yml`, which re-runs both smoke
suites, fails if `package.json` doesn't match the tag, creates the GitHub release
with the tarball attached, and publishes to npm via Trusted Publishing (OIDC).
No tokens exist anywhere in the chain.

## Invariants

- `package.json` version == git tag (CI enforces)
- source changes travel with their rebuilt `dist/` in the same commit (CI enforces)
- every released version has a CHANGELOG entry (release script enforces)
- users are affected only by npm publishes; GitHub releases mirror the npm publish

## If something goes wrong

- Release workflow failed before `npm publish` → fix, delete the local+remote tag, re-cut.
- Published a bad version → `npm deprecate @albsugy/aos@X.Y.Z "use X.Y.Z+1"` and ship a fix;
  never unpublish (breaks installs downstream).
- Emergency manual publish (bypasses CI — last resort): `npm publish` locally; 2FA applies.
