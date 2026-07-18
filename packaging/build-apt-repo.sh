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

rm -rf "$REPO"
mkdir -p "$REPO/pool/main" "$REPO/dists/stable/main/binary-amd64" "$REPO/dists/stable/main/binary-arm64"
cp dist/*.deb "$REPO/pool/main/"

cd "$REPO"
# Package is Architecture: all — list it for both amd64 and arm64 clients.
dpkg-scanpackages --multiversion pool > dists/stable/main/binary-amd64/Packages
cp dists/stable/main/binary-amd64/Packages dists/stable/main/binary-arm64/Packages
gzip -k9 dists/stable/main/binary-amd64/Packages
gzip -k9 dists/stable/main/binary-arm64/Packages

apt-ftparchive \
  -o APT::FTPArchive::Release::Origin="nnm-control" \
  -o APT::FTPArchive::Release::Label="nnm-control" \
  -o APT::FTPArchive::Release::Suite="stable" \
  -o APT::FTPArchive::Release::Codename="stable" \
  -o APT::FTPArchive::Release::Architectures="amd64 arm64" \
  -o APT::FTPArchive::Release::Components="main" \
  release dists/stable > dists/stable/Release

"${GPG[@]}" --detach-sign --armor -o dists/stable/Release.gpg dists/stable/Release
"${GPG[@]}" --clearsign -o dists/stable/InRelease dists/stable/Release
gpg --batch --yes --armor --export "$KEYID" > gpg.key

echo "APT repo ready under public/apt"
