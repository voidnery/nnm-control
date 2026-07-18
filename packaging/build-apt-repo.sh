#!/usr/bin/env bash
# Builds a signed flat APT repository under public/apt from dist/*.deb.
# Requires: dpkg-dev, apt-utils, gnupg; a default-key set up in gpg.
# Usage: packaging/build-apt-repo.sh <gpg-key-id>
set -euo pipefail
cd "$(dirname "$0")/.."

KEYID="${1:?gpg key id required}"
REPO=public/apt

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

gpg --batch --yes -u "$KEYID" --detach-sign --armor -o dists/stable/Release.gpg dists/stable/Release
gpg --batch --yes -u "$KEYID" --clearsign -o dists/stable/InRelease dists/stable/Release
gpg --batch --yes --armor --export "$KEYID" > gpg.key

echo "APT repo ready under public/apt"
