#!/usr/bin/env bash
# Builds a signed flat APT repository under public/apt from dist/*.deb.
# Requires: dpkg-dev, apt-utils, gnupg; the signing key imported into gpg.
# Usage:  packaging/build-apt-repo.sh <gpg-key-id>
# Env:    APT_GPG_PASSPHRASE — optional; set it if the private key is
#           passphrase-protected (loopback pinentry is used for signing).
#         APT_POOL_DIR — a checkout of the published gh-pages branch. Preferred
#           source for the existing pool.
#         APT_PUBLIC_BASE — published repo URL; fallback pool source when
#           APT_POOL_DIR is unset or empty.
set -euo pipefail
cd "$(dirname "$0")/.."

KEYID="${1:?gpg key id required}"
REPO=public/apt
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

GPG=(gpg --batch --yes -u "$KEYID")
if [ -n "${APT_GPG_PASSPHRASE:-}" ]; then
  GPG+=(--pinentry-mode loopback --passphrase "$APT_GPG_PASSPHRASE")
fi

# The .deb this run is publishing. Everything else in the pool is history.
CURRENT="$(ls -1 dist/*.deb 2>/dev/null | head -1 || true)"
[ -n "$CURRENT" ] || { echo "no .deb in dist/ — build-deb.sh first" >&2; exit 1; }
CURVER="$(dpkg-deb -f "$CURRENT" Version)"
echo "Publishing $(basename "$CURRENT") (Version: $CURVER)"

# ---------------------------------------------------------------- prior pool
#
# Preserve the pool across releases. The rm -rf below rebuilds the repository
# from scratch, so without this a release would publish only its own .deb and
# every earlier version would vanish from the index — breaking both rollback
# (`apt install nnm-control=<old>`) and any machine mid-upgrade.
#
# The source is a checkout of gh-pages, not the Pages URL. Pages is served
# through a CDN and its deployment can lag or be cancelled; reading the pool
# from there means a stale cache silently drops versions from the index while
# the files themselves are still on the branch. The branch is the truth.
# The URL remains as a fallback so the script still works run by hand.
PRIOR="$STAGE/prior"
mkdir -p "$PRIOR"
POOL_DIR="${APT_POOL_DIR:-}"
if [ -n "$POOL_DIR" ] && [ -d "$POOL_DIR/apt/pool/main" ]; then
  echo "Preserving existing pool from $POOL_DIR (gh-pages checkout)"
  cp "$POOL_DIR"/apt/pool/main/*.deb "$PRIOR/" 2>/dev/null || true
elif [ -n "${APT_PUBLIC_BASE:-}" ]; then
  BASE="$APT_PUBLIC_BASE"
  echo "Preserving existing pool from $BASE (published index)"
  idx="$(curl -fsSL "$BASE/dists/stable/main/binary-amd64/Packages" 2>/dev/null || true)"
  printf '%s\n' "$idx" | awk '/^Filename:/{print $2}' | while read -r fn; do
    [ -n "$fn" ] || continue
    b="$(basename "$fn")"
    curl -fsSL "$BASE/$fn" -o "$PRIOR/$b" \
      || { echo "  WARN: could not fetch $b — it will drop from the pool"; rm -f "$PRIOR/$b"; }
  done
else
  echo "No pool source configured — publishing this release only"
fi
# The current build is not history; drop any same-named copy pulled back in.
rm -f "$PRIOR/$(basename "$CURRENT")"

# --------------------------------------------------------- ordering assertion
#
# The one failure that is silent. apt offers an upgrade only when the new
# version sorts strictly above the installed one, and `0.59.0` sorts *below*
# the stray `1.8.x` already in this pool — so a release that forgets the epoch
# publishes cleanly, reports success, and reaches no server. Refuse to build
# such a repository at all.
for f in "$PRIOR"/*.deb; do
  [ -e "$f" ] || continue
  v="$(dpkg-deb -f "$f" Version)"
  if ! dpkg --compare-versions "$CURVER" gt "$v"; then
    echo "ERROR: $CURVER does not sort above $v (already in the pool)." >&2
    echo "       apt would not offer this release as an upgrade. Check the" >&2
    echo "       Debian epoch on deb_version in .github/workflows/release.yml." >&2
    exit 1
  fi
  echo "  kept $(basename "$f")  ($v)"
done

# ------------------------------------------------------------------- assemble
rm -rf "$REPO"
mkdir -p "$REPO/pool/main" "$REPO/dists/stable/main/binary-amd64"
cp "$CURRENT" "$REPO/pool/main/"
cp "$PRIOR"/*.deb "$REPO/pool/main/" 2>/dev/null || true

# A stamp, so every build produces content that differs from the last.
#
# peaceiris/actions-gh-pages does not push when the tree is identical, and a
# run that pushes nothing creates no new commit — so a re-run intended to
# retry a stuck Pages deployment simply re-deploys the same version, which
# GitHub then cancels against the one already in flight. This also makes what
# is actually published readable from a browser.
{
  echo "built:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "run:     ${GITHUB_RUN_ID:-local}"
  echo "commit:  ${GITHUB_SHA:-unknown}"
  echo "release: $(basename "$CURRENT")  (Version: $CURVER)"
  echo "pool:    $(ls -1 "$REPO/pool/main" | wc -l) package(s)"
} > "$REPO/build-info.txt"

cd "$REPO"
dpkg-scanpackages --multiversion pool > dists/stable/main/binary-amd64/Packages
gzip -k9 dists/stable/main/binary-amd64/Packages

apt-ftparchive \
  -o APT::FTPArchive::Release::Origin="nnm-control" \
  -o APT::FTPArchive::Release::Label="nnm-control" \
  -o APT::FTPArchive::Release::Suite="stable" \
  -o APT::FTPArchive::Release::Codename="stable" \
  -o APT::FTPArchive::Release::Architectures="amd64" \
  -o APT::FTPArchive::Release::Components="main" \
  release dists/stable > dists/stable/Release

"${GPG[@]}" --detach-sign --armor -o dists/stable/Release.gpg dists/stable/Release
"${GPG[@]}" --clearsign -o dists/stable/InRelease dists/stable/Release
gpg --batch --yes --armor --export "$KEYID" > gpg.key

echo "APT repo ready under public/apt"
