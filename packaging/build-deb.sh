#!/usr/bin/env bash
# Builds the nnm-control .deb.
# Usage: packaging/build-deb.sh <version> <ghcr-owner> [outdir]
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?version required, e.g. 0.2.0}"
OWNER="${2:?ghcr owner required, e.g. voidnery}"
OUT="${3:-dist}"

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
chmod 755 "$ROOT"

mkdir -p "$ROOT/DEBIAN" "$ROOT/opt/nnm-control" "$ROOT/usr/bin" "$ROOT/lib/systemd/system" "$ROOT/usr/share/nnm-control/tools"

sed -e "s/__VERSION__/${VERSION}/" -e "s/__OWNER__/${OWNER}/" packaging/debian/control > "$ROOT/DEBIAN/control"
cp packaging/debian/templates "$ROOT/DEBIAN/templates"
cp packaging/debian/config "$ROOT/DEBIAN/config"
sed -e "s/__OWNER__/${OWNER}/" packaging/debian/postinst > "$ROOT/DEBIAN/postinst"
cp packaging/debian/prerm "$ROOT/DEBIAN/prerm"
cp packaging/debian/postrm "$ROOT/DEBIAN/postrm"
chmod 755 "$ROOT/DEBIAN/config" "$ROOT/DEBIAN/postinst" "$ROOT/DEBIAN/prerm" "$ROOT/DEBIAN/postrm"

cp docker-compose.yml "$ROOT/opt/nnm-control/docker-compose.yml"
cp packaging/nnm-control-cli "$ROOT/usr/bin/nnm-control"
chmod 755 "$ROOT/usr/bin/nnm-control"
# Engineering tools shipped with the panel (e.g. WMSPanel API dump)
cp tools/*.sh "$ROOT/usr/share/nnm-control/tools/"
chmod 755 "$ROOT/usr/share/nnm-control/tools/"*.sh
cp packaging/nnm-control.service "$ROOT/lib/systemd/system/nnm-control.service"
cp packaging/nnm-control-backup.service packaging/nnm-control-backup.timer "$ROOT/lib/systemd/system/"

mkdir -p "$OUT"
dpkg-deb --build --root-owner-group "$ROOT" "$OUT/nnm-control_${VERSION}_all.deb"
echo "Built: $OUT/nnm-control_${VERSION}_all.deb"
