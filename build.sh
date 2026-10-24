#!/usr/bin/env bash
# build.sh — пакет NNM-Control для DIST-Control и eterix-updater: dist/nnm-control_<VERSION>_all.deb +
# SHA256SUMS. Его же зовёт package eterix-ci (build-command: bash ./build.sh). Тонкий пакет (upd/0 P1–P3):
#   - backend — исходники и production node_modules без нативного кода (поэтому Architecture: all),
#     версия впекается в backend/build-info.json (её отдаёт /healthz);
#   - frontend собирается здесь (vite), в пакет идёт готовая статика и шаблон nginx;
#   - на хосте ничего не собирается: compose берёт стоковые образы по дайджесту и монтирует
#     приложение из /opt/nnm-control только на чтение (packaging/eterix/compose.yml).
# Пакет старого пути (GitHub Pages APT, эпоха 1:, образы GHCR) собирает packaging/build-deb.sh —
# только legacy-apt.yml.
# Окружение:
#   OUT=dist            каталог результата;
#   STAGE_ONLY=1        только собрать дерево пакета (.stage/), без dpkg-deb (машина без dpkg);
#   NNM_DEFECT=version  ДЕФЕКТНАЯ сборка для DEFECTIVE-прогона автоотката (класс B): /healthz
#                       сообщает чужую версию, postinst её не сверяет — откат обязан поймать движок.
#                       В CI вместо переменной — файл DEFECT (одна строка, например «version») в ветке
#                       defective/X.Y.Z (D-0032): workflow на такой ветке не меняют.
#                       Файл DEFECT в любой другой ветке — отказ сборки.
set -euo pipefail
cd "$(dirname "$0")"
VER=$(tr -d '\r\n' < VERSION)
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "build: VERSION «$VER» — ожидается X.Y.Z (ERS/1 §4)" >&2; exit 1; }
for f in backend/package.json frontend/package.json; do
  pv=$(node -p "require('./$f').version")
  [ "$pv" = "$VER" ] || { echo "build: $f — $pv, а VERSION — $VER: поднимите оба package.json" >&2; exit 1; }
done
OUT=${OUT:-dist}
P=nnm-control
DEFECT=${NNM_DEFECT:-}
if [ -z "$DEFECT" ] && [ -f DEFECT ]; then
  BRANCH=${GITHUB_REF_NAME:-$(git -c safe.directory='*' rev-parse --abbrev-ref HEAD 2>/dev/null || true)}
  case "$BRANCH" in
    defective/*) DEFECT=$(tr -d '\r\n' < DEFECT) ;;
    *) echo "build: файл DEFECT в ветке «$BRANCH» — дефектная сборка только из defective/X.Y.Z (D-0032)" >&2; exit 1 ;;
  esac
fi
BUILD_ID=${GITHUB_SHA:-$(git -c safe.directory='*' rev-parse --short=12 HEAD 2>/dev/null || echo local)}
BUILD_ID=${BUILD_ID:0:12}
HEALTH_VERSION=$VER; SKIP_PROBE=no; DESC_SUFFIX=""
case "$DEFECT" in
  '') ;;
  version) HEALTH_VERSION="0.0.0-defective"; SKIP_PROBE=yes; DESC_SUFFIX=" [DEFECTIVE: health version mismatch, rollback test only]" ;;
  *) echo "build: неизвестный NNM_DEFECT «$DEFECT» (есть: version)" >&2; exit 1 ;;
esac
echo "== $P $VER (build $BUILD_ID${DEFECT:+, DEFECT=$DEFECT})"

# --- frontend ----------------------------------------------------------------------------------
(cd frontend && npm ci --no-audit --no-fund --loglevel=error && npm run build)
(cd backend && npm ci --no-audit --no-fund --loglevel=error)   # для перечня лицензий (ci/license-audit.mjs)

# --- stage -------------------------------------------------------------------------------------
STAGE=.stage/$P
rm -rf .stage; mkdir -p "$STAGE"
APP=$STAGE/opt/$P
install -d "$APP/backend" "$APP/www" "$APP/nginx"
cp -R backend/src "$APP/backend/src"
install -d "$APP/backend/tools"
cp backend/tools/*.mjs "$APP/backend/tools/"
cp backend/package.json backend/package-lock.json "$APP/backend/"
(cd "$APP/backend" && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$APP/backend/package-lock.json"
find "$APP/backend/node_modules" -type d -empty -delete
if [ -n "$(find "$APP/backend/node_modules" -name '*.node' -print -quit)" ]; then
  echo "build: в production node_modules есть нативный код — пакет не может быть Architecture: all" >&2; exit 1
fi
printf '{"version":"%s","build":"%s"}\n' "$HEALTH_VERSION" "$BUILD_ID" > "$APP/backend/build-info.json"
cp -R frontend/dist/. "$APP/www/"
install -m 0644 frontend/nginx/default.conf.template "$APP/nginx/default.conf.template"
install -m 0644 packaging/eterix/compose.yml "$APP/docker-compose.yml"

install -D -m 0755 packaging/eterix/compose-wrapper.sh "$STAGE/usr/lib/$P/compose"
install -D -m 0755 packaging/nnm-control-cli "$STAGE/usr/bin/nnm-control"
install -D -m 0644 packaging/eterix/updater.json "$STAGE/usr/share/eterix/$P/updater.json"
install -d "$STAGE/usr/lib/eterix/$P/hooks"
for h in snapshot restore stop start; do install -m 0755 "packaging/eterix/hooks/$h" "$STAGE/usr/lib/eterix/$P/hooks/$h"; done
install -D -m 0644 packaging/eterix/nnm-control.service "$STAGE/usr/lib/systemd/system/$P.service"
install -m 0644 packaging/nnm-control-backup.service packaging/nnm-control-backup.timer "$STAGE/usr/lib/systemd/system/"
install -d "$STAGE/usr/share/$P/tools"
install -m 0755 tools/*.sh "$STAGE/usr/share/$P/tools/"

DOC=$STAGE/usr/share/doc/$P
install -d "$DOC"
install -m 0644 README.md SECURITY.md docs/STATE.md docs/LICENSES-AUDIT.md "$DOC/"
# The full CHANGELOG is half a megabyte of reasoning; the package carries the recent part.
awk '/^##(#)? v?[0-9]/ { n++ } n > 40 { exit } { print }' CHANGELOG.md > "$DOC/CHANGELOG.md"
install -m 0644 LICENSE "$DOC/copyright"
install -m 0644 .env.example "$DOC/env.example"
node ci/license-audit.mjs --notices "$DOC/THIRD-PARTY-NOTICES"

# Normalised permissions: files 0644, directories 0755; executables set explicitly above.
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE/opt" -type f -exec chmod 0644 {} +
chmod 0644 "$DOC"/*

# --- control -----------------------------------------------------------------------------------
install -d "$STAGE/DEBIAN"
SIZE_KB=$(du -sk "$STAGE" | cut -f1)
sed -e "s/@VERSION@/$VER/" -e "s/@INSTALLED_SIZE@/$SIZE_KB/" \
    -e "s/^\(Description: .*\)$/\1$DESC_SUFFIX/" packaging/eterix/debian/control > "$STAGE/DEBIAN/control"
for f in preinst postinst prerm postrm config; do
  sed -e "s/@VERSION@/$VER/g" -e "s/@SKIP_PROBE@/$SKIP_PROBE/g" "packaging/eterix/debian/$f" > "$STAGE/DEBIAN/$f"
  chmod 0755 "$STAGE/DEBIAN/$f"
done
install -m 0644 packaging/eterix/debian/templates "$STAGE/DEBIAN/templates"

# Guards on the staged tree (the same rules check-deb applies to the .deb).
for f in preinst postinst prerm postrm config; do sh -n "$STAGE/DEBIAN/$f"; done
for h in snapshot restore stop start; do sh -n "$STAGE/usr/lib/eterix/$P/hooks/$h"; done
sh -n "$STAGE/usr/lib/$P/compose"
if grep -rIl '=CHANGE_ME' "$STAGE" >/dev/null 2>&1; then
  echo "build: заглушки =CHANGE_ME в пакете: $(grep -rIl '=CHANGE_ME' "$STAGE" | head -3)" >&2; exit 1
fi
if grep -rl '@[A-Z_]*@' "$STAGE/DEBIAN" >/dev/null 2>&1; then
  echo "build: неподставленные @…@ в DEBIAN/" >&2; exit 1
fi
if grep -qE '^[[:space:]]*read[[:space:]]' "$STAGE/DEBIAN/postinst"; then
  echo "build: postinst читает stdin — вопросы только через debconf" >&2; exit 1
fi
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(d.schema_version!=="upd-desc/0"||d.product!=="nnm-control"||d.package!=="nnm-control") process.exit(1)' \
  "$STAGE/usr/share/eterix/$P/updater.json" || { echo "build: updater.json не по upd-desc/0" >&2; exit 1; }
echo "== дерево пакета: $STAGE ($SIZE_KB КБ)"

if [ "${STAGE_ONLY:-0}" = 1 ]; then echo "== STAGE_ONLY=1: .deb не собирается"; exit 0; fi
command -v dpkg-deb >/dev/null 2>&1 || { echo "build: нет dpkg-deb — сборка .deb только на Linux (STAGE_ONLY=1 — проверить дерево)" >&2; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT"
DEB="$OUT/${P}_${VER}_all.deb"
dpkg-deb --root-owner-group -Zxz --build "$STAGE" "$DEB" >/dev/null
(cd "$OUT" && sha256sum "$(basename "$DEB")" > SHA256SUMS)
rm -rf .stage
echo "== готово: $DEB ($(stat -c%s "$DEB") байт)"
