#!/usr/bin/env bash
# Prepare a release: bump, changelog-check, build, test, commit, tag.
# Pushing (and therefore publishing) stays a deliberate, separate step.
#
#   npm run release -- patch          # or minor / major / an explicit version
#   git push origin main vX.Y.Z       # ships it: CI verifies, releases, publishes via OIDC
set -euo pipefail
cd "$(dirname "$0")/.."

ARG="${1:?usage: npm run release -- <patch|minor|major|x.y.z>}"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "✖ Node >= 22 required (found $(node -v))"; exit 1; }

[ "$(git branch --show-current)" = "main" ] || { echo "✖ releases are cut from main"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "✖ working tree not clean — commit or stash first"; exit 1; }

NEW="$(npm version "$ARG" --no-git-tag-version)"   # updates package.json + lockfile
NEW="${NEW#v}"

# Changelog discipline: refuse to release undocumented versions.
if ! grep -q "^## ${NEW} " CHANGELOG.md; then
  git checkout -- package.json package-lock.json
  echo "✖ CHANGELOG.md has no \"## ${NEW}\" entry — write it first"
  exit 1
fi

npm run build
npm test

git add -A
git commit -m "release: v${NEW}"
git tag "v${NEW}"

echo ""
echo "✔ v${NEW} committed and tagged locally."
echo "  Ship it:   git push origin main v${NEW}"
echo "  (CI re-verifies both suites, creates the GitHub release, and publishes to npm via OIDC.)"
