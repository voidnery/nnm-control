#!/usr/bin/env bash
# Tags a release from the version in package.json and pushes it.
#
# The tag and package.json have to agree — CI refuses the release when they do
# not, and that refusal is what stopped delivery once already: `v1.8.7` pushed
# against a tree saying 0.59.0, both jobs dead on their first step, nothing
# published and no obvious sign that the tag was the problem. So the tag is
# derived here instead of typed.
#
# Usage: packaging/tag-release.sh [--push]
#        without --push it only reports what it would do.
set -euo pipefail
cd "$(dirname "$0")/.."

PUSH=0
[ "${1:-}" = "--push" ] && PUSH=1

fe="$(node -p "require('./frontend/package.json').version")"
be="$(node -p "require('./backend/package.json').version")"
if [ "$fe" != "$be" ]; then
  echo "ERROR: frontend ($fe) and backend ($be) package.json disagree." >&2
  exit 1
fi
TAG="v$fe"

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty; commit before tagging." >&2
  git status --short >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "ERROR: tag $TAG already exists. Bump the version in both package.json" >&2
  echo "       files (and CHANGELOG.md) before releasing again." >&2
  exit 1
fi

# The version must also outrank what is published, or apt offers nothing and
# says nothing. Advisory: this needs the network and the release itself
# re-checks it against the real pool before signing anything.
BASE="${APT_PUBLIC_BASE:-https://$(git config --get remote.origin.url | sed -E 's#.*[:/]([^/]+)/[^/]+$#\1#' | tr 'A-Z' 'a-z').github.io/nnm-control/apt}"
published="$(curl -fsSL "$BASE/dists/stable/main/binary-amd64/Packages" 2>/dev/null \
  | awk '/^Version:/{print $2}' | sort -u || true)"
if [ -n "$published" ]; then
  for v in $published; do
    if ! dpkg --compare-versions "1:$fe" gt "$v" 2>/dev/null; then
      echo "WARNING: 1:$fe does not sort above published $v — apt would not"
      echo "         offer this as an upgrade. The release will refuse to sign."
    fi
  done
fi

echo "version:  $fe (both package.json agree)"
echo "tag:      $TAG on $(git rev-parse --short HEAD)"
echo "deb:      1:$fe"
[ -n "$published" ] && echo "published: $(echo "$published" | tr '\n' ' ')"

if [ "$PUSH" -eq 1 ]; then
  git tag -a "$TAG" -m "$TAG"
  git push origin "$TAG"
  echo "pushed $TAG — watch: gh run watch or the Actions tab"
else
  echo
  echo "dry run. To release:  packaging/tag-release.sh --push"
fi
