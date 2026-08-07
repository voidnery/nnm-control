#!/usr/bin/env bash
# Builds a signed flat APT repository under public/apt from dist/*.deb.
# Requires: dpkg-dev, apt-utils, gnupg; the signing key imported into gpg.
# Usage:  packaging/build-apt-repo.sh <gpg-key-id>
# Env:    APT_GPG_PASSPHRASE — optional; set it if the private key is
#         passphrase-protected (loopback pinentry is used for signing).
set -euo pipefail
cd "$(dirname "$0")/.."

KEYID="${1:?gpg key id required}"
REPO=public/apt

GPG=(gpg --batch --yes -u "$KEYID")
if [ -n "${APT_GPG_PASSPHRASE:-}" ]; then
  GPG+=(--pinentry-mode loopback --passphrase "$APT_GPG_PASSPHRASE")
fi

# Preserve the pool across releases. The rm -rf below rebuilds the repository
# from dist/, so without this a release would publish only its own .deb and
# every earlier version would vanish from the index — breaking both rollback
# (`apt install nnm-control=<old>`) and any machine mid-upgrade. Pull the
# already-published .debs back into dist/ first. A fetch failure is a warning,
# not a stop: a first-ever run has nothing to fetch, which is not an error.
BASE="${APT_PUBLIC_BASE:-}"
if [ -n "$BASE" ]; then
  echo "Preserving existing pool from $BASE"
  idx="$(curl -fsSL "$BASE/dists/stable/main/binary-amd64/Packages" 2>/dev/null || true)"
  printf '%s\n' "$idx" | awk '/^Filename:/{print $2}' | while read -r fn; do
    [ -n "$fn" ] || continue
    b="$(basename "$fn")"
    [ -f "dist/$b" ] && continue                 # current build already staged
    if curl -fsSL "$BASE/$fn" -o "dist/$b"; then
      echo "  kept $b"
    else
      echo "  WARN: could not fetch $b — it will drop from the pool"; rm -f "dist/$b"
    fi
  done
fi

rm -rf "$REPO"
mkdir -p "$REPO/pool/main" "$REPO/dists/stable/main/binary-amd64"
cp dist/*.deb "$REPO/pool/main/"

# A stamp, so every build produces content that differs from the last.
#
# peaceiris/actions-gh-pages does not push when the tree is identical, and a
# run that pushes nothing creates no new commit — so a re-run intended to
# retry a stuck Pages deployment simply re-deploys the same version, which
# GitHub then cancels against the one already in flight. This also makes what
# is actually published readable from a browser.
{
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "run:   ${GITHUB_RUN_ID:-local}"
  echo "commit: ${GITHUB_SHA:-unknown}"
  ls -1 dist/*.deb 2>/dev/null | sed 's|.*/|deb:    |'
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
