#!/usr/bin/env bash
# ci/e2e-deb.sh [dist] — e2e собранного пакета (класс B; upd/0 P18: ставится СОБРАННЫЙ .deb, обе ветки —
# чистая установка и обновление, проверяется наблюдаемый результат, а не только коды возврата).
# Где: одноразовая ВМ или раннер Ubuntu 22.04/24.04 с systemd (PID 1) и Docker; меняет систему.
# В CI — гейт продукта auto-release (gates-command в release.yml): в пути выпуска и при ручной проверке,
# не на каждый push (D-0023). Запуск на ВМ: sudo bash ci/e2e-deb.sh dist
#
# Движок обновлений здесь — заглушка (eterix-update пишет вызовы в журнал, юниты-пустышки):
# настоящий движок и откат проверяются гейтами eterix-updater и DEFECTIVE-прогоном.
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo -E bash "$0" "$@"
DIST=$(cd "${1:-dist}" && pwd)
DEB=$(ls "$DIST"/nnm-control_*_all.deb | head -n 1)
VER=$(dpkg-deb -f "$DEB" Version)

# Дефектная сборка (build.sh, файл DEFECT, D-0032) обязана провалить health — e2e к ней не применим,
# её проверяет DEFECTIVE-прогон движка. Только из ветки defective/X.Y.Z; в любой другой — красный.
case "$(dpkg-deb -f "$DEB" Description | head -n 1)" in
  *'[DEFECTIVE'*)
    BRANCH=${GITHUB_REF_NAME:-$(git -c safe.directory='*' -C "$(dirname "$0")/.." rev-parse --abbrev-ref HEAD 2>/dev/null || true)}
    case "$BRANCH" in
      defective/*) echo "e2e: дефектная сборка $VER из $BRANCH — e2e не применим, проверка — DEFECTIVE-прогон движка"; exit 0 ;;
      *) echo "e2e: КРАСНЫЙ — дефектная сборка вне ветки defective/X.Y.Z («$BRANCH»)" >&2; exit 1 ;;
    esac ;;
esac
P=nnm-control
C=/usr/lib/$P/compose
H=/usr/lib/eterix/$P/hooks
HEALTH=http://127.0.0.1:8580/healthz
PORT=8090
PANEL=http://127.0.0.1:$PORT
W=$(mktemp -d)
STUBLOG=/var/log/eterix-update-stub.log
ADMIN_PW="e2e-$(openssl rand -hex 8)"
export DEBIAN_FRONTEND=noninteractive

log() { echo "e2e: $*"; }
diag() {
  echo "---- диагностика" >&2
  journalctl -u $P -n 40 --no-pager >&2 || true
  "$C" ps -a >&2 || true
  "$C" logs --tail 40 >&2 || true
}
fail() { echo "e2e: КРАСНЫЙ — $*" >&2; diag; exit 1; }
health_version() { curl -fsS -m 5 "$HEALTH" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
api() { # api METHOD PATH [JSON] [TOKEN] → тело; код — в $W/code
  local args=(-sS -m 10 -o "$W/body" -w '%{http_code}' -X "$1" "$PANEL/api$2" -H 'Content-Type: application/json')
  [ -n "${3:-}" ] && args+=(--data "$3")
  [ -n "${4:-}" ] && args+=(-H "Authorization: Bearer $4")
  curl "${args[@]}" > "$W/code" || true
  cat "$W/body"
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));console.log(Array.isArray(v)?JSON.stringify(v):v??"")})' "$1"; }
login() { api POST /auth/login "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" | json token; }
wait_health() { for _ in $(seq 1 90); do [ "$(health_version 2>/dev/null)" = "$1" ] && return 0; sleep 2; done; return 1; }

# --- 0. Заглушки: движок, keyring; на раннерах GitHub Docker стоит из пакетов moby — пустые
#        docker.io / docker-compose-v2 удовлетворяют Depends, сам Docker уже есть.
mkstub() { # имя версия [каталог-с-файлами]
  local d="$W/stub-$1"; mkdir -p "$d/DEBIAN"; [ -n "${3:-}" ] && cp -a "$3/." "$d/"
  printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: e2e <e2e@example.test>\nDescription: e2e stub %s\n' "$1" "$2" "$1" > "$d/DEBIAN/control"
  dpkg-deb --root-owner-group -b "$d" "$W/$1_$2_all.deb" >/dev/null
}
U="$W/updater-root"
mkdir -p "$U/usr/bin" "$U/usr/lib/systemd/system"
cat > "$U/usr/bin/eterix-update" <<EOF
#!/bin/sh
echo "\$*" >> $STUBLOG
exit 0
EOF
chmod 0755 "$U/usr/bin/eterix-update"
for unit in 'eterix-update@.service' 'eterix-update-check@.service'; do
  printf '[Unit]\nDescription=e2e stub\n[Service]\nType=oneshot\nExecStart=/bin/true\n' > "$U/usr/lib/systemd/system/$unit"
done
printf '[Unit]\nDescription=e2e stub\n[Path]\nPathExistsGlob=/var/lib/eterix/%%i/requests/*.json\n[Install]\nWantedBy=multi-user.target\n' > "$U/usr/lib/systemd/system/eterix-update@.path"
printf '[Unit]\nDescription=e2e stub\n[Timer]\nOnCalendar=daily\n[Install]\nWantedBy=timers.target\n' > "$U/usr/lib/systemd/system/eterix-update-check@.timer"
mkstub eterix-updater 0.5.4 "$U"
mkstub eterix-keyring 0.0.1
stubs="$W/eterix-updater_0.5.4_all.deb $W/eterix-keyring_0.0.1_all.deb"
dpkg -s docker.io >/dev/null 2>&1 || dpkg -s docker-ce >/dev/null 2>&1 || { mkstub docker.io 99.0; stubs="$stubs $W/docker.io_99.0_all.deb"; }
dpkg -s docker-compose-v2 >/dev/null 2>&1 || dpkg -s docker-compose-plugin >/dev/null 2>&1 || { mkstub docker-compose-v2 99.0; stubs="$stubs $W/docker-compose-v2_99.0_all.deb"; }
# shellcheck disable=SC2086
dpkg -i $stubs >/dev/null
docker compose version >/dev/null || fail "нет docker compose v2"
log "заглушки установлены; пакет $DEB ($VER)"

# --- 1. Чистая установка ----------------------------------------------------------------------
printf '%s\n' "$P $P/domain string panel.example.test" "$P $P/port string $PORT" | debconf-set-selections
apt-get install -y "$DEB" > "$W/install.log" 2>&1 || { cat "$W/install.log" >&2; fail "установка $VER"; }
log "установлен $VER"
[ "$(health_version)" = "$VER" ] || fail "/healthz на 127.0.0.1:8580 не сообщает $VER"
ENVF=/etc/$P/$P.env
[ "$(stat -c '%a %U' "$ENVF")" = "600 root" ] || fail "$ENVF — не 0600 root"
grep -qx "APP_DOMAIN=panel.example.test" "$ENVF" || fail "ответ debconf (домен) не записан"
grep -qx "APP_PORT=$PORT" "$ENVF" || fail "ответ debconf (порт) не записан"
grep -qE '^JWT_SECRET=[0-9a-f]{64}$' "$ENVF" || fail "JWT_SECRET не сгенерирован"
SETUP_TOKEN=$(sed -n 's/^SETUP_TOKEN=//p' "$ENVF")
[ -n "$SETUP_TOKEN" ] || fail "SETUP_TOKEN не сгенерирован"
if grep -qF "$SETUP_TOKEN" "$W/install.log"; then fail "токен настройки попал в вывод установки (rev.17 §8.3 п.3)"; fi
grep -q 'sudo nnm-control setup-token' "$W/install.log" || fail "вывод установки не говорит, как получить токен настройки"
[ "$(nnm-control setup-token)" = "$SETUP_TOKEN" ] || fail "nnm-control setup-token не отдаёт токен"
for h in snapshot restore stop start; do [ "$(stat -c '%a %U' "$H/$h")" = "755 root" ] || fail "хук $h — не 0755 root"; done
[ -f /usr/share/eterix/$P/updater.json ] || fail "нет дескриптора updater.json"
[ -s /usr/share/doc/$P/THIRD-PARTY-NOTICES ] || fail "нет THIRD-PARTY-NOTICES"
systemctl is-enabled --quiet "eterix-update@$P.path" || fail "не включён eterix-update@$P.path (P14)"
systemctl is-enabled --quiet "eterix-update-check@$P.timer" || fail "не включён eterix-update-check@$P.timer (P14)"
systemctl is-enabled --quiet $P.service || fail "не включён $P.service"
systemctl is-enabled --quiet $P-backup.timer || fail "не включён $P-backup.timer"
[ "$(stat -c '%a' /var/lib/eterix/$P/requests)" = 770 ] || fail "каталог запросов не 0770 (P15)"
# Публикация портов — по конфигурации контейнеров (с userland-proxy и без него одинаково).
binds() { docker inspect -f '{{json .HostConfig.PortBindings}}' "$("$C" ps -q "$1")"; }
[ "$(binds mongo)" = '{}' ] || fail "MongoDB опубликован на хосте: $(binds mongo)"
binds web | grep -q '"HostIp":"127.0.0.1","HostPort":"8580"' || fail "порт проверки здоровья не на 127.0.0.1:8580: $(binds web)"
if binds web | grep -q '"HostIp":"","HostPort":"8580"\|"HostIp":"0.0.0.0","HostPort":"8580"'; then fail "8580 открыт не только на loopback"; fi

# Первый вход: суперадминистратор по токену настройки.
[ "$(api GET /setup/status | json needsSetup)" = true ] || fail "панель не ждёт первичной настройки"
api POST /setup "{\"token\":\"$SETUP_TOKEN\",\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" >/dev/null
[ "$(cat "$W/code")" = 201 ] || fail "суперадминистратор не создан ($(cat "$W/code"): $(cat "$W/body"))"
TOKEN=$(login)
[ -n "$TOKEN" ] || fail "вход администратора не удался"

# Редакция Free: один сервер (license/limits.js). Второй — отказ 403 с понятным текстом, первый цел.
api POST /servers '{"name":"e2e-keep","host":"192.0.2.10"}' "$TOKEN" >/dev/null
[ "$(cat "$W/code")" = 201 ] || fail "первый сервер не создан ($(cat "$W/code"))"
api POST /servers '{"name":"e2e-second","host":"192.0.2.11"}' "$TOKEN" > "$W/refusal.json"
if [ "${VER%%.*}" -ge 2 ]; then
  [ "$(cat "$W/code")" = 403 ] || fail "второй сервер в редакции Free не отклонён (код $(cat "$W/code"))"
  json error < "$W/refusal.json" | grep -q '^Редакция Free: серверов — не больше 1' || fail "отказ без текста «Редакция Free…»: $(cat "$W/refusal.json")"
  [ "$(json code < "$W/refusal.json")" = license_limit ] || fail "в отказе нет code=license_limit"
  [ "$(api GET /servers '' "$TOKEN" | json 1.name)" = "" ] || fail "отклонённый сервер всё-таки создан"
else
  # До 2.0 лимит выключен (license/limits.js ENFORCED_FROM_MAJOR): второй сервер создаётся.
  [ "$(cat "$W/code")" = 201 ] || fail "в $VER лимита быть не должно, а второй сервер не создан (код $(cat "$W/code"))"
  api DELETE "/servers/$(json id < "$W/refusal.json")" '' "$TOKEN" >/dev/null
fi
[ "$(api GET /servers '' "$TOKEN" | json 0.name)" = e2e-keep ] || fail "первый сервер не читается"
[ "$(api GET /servers '' "$TOKEN" | json 1.name)" = "" ] || fail "лишний сервер остался"
log "чистая установка, первый вход и лимит Free: наблюдаемый результат верен"

# --- 2. Обновление на ту же сборку с версией выше (ручной путь apt: preinst снимает снимок) -----
VER2="${VER}+e2e1"
R="$W/repack"; dpkg-deb -R "$DEB" "$R"
sed -i "s/^Version: .*/Version: $VER2/" "$R/DEBIAN/control"
sed -i "s/^SELF=.*/SELF=$VER2/" "$R/DEBIAN/preinst" "$R/DEBIAN/postinst"
sed -i "s/\"version\":\"[^\"]*\"/\"version\":\"$VER2\"/" "$R/opt/$P/backend/build-info.json"
DEB2="$W/${P}_${VER2}_all.deb"; dpkg-deb --root-owner-group -Zxz -b "$R" "$DEB2" >/dev/null
ENV_SUM=$(sha256sum "$ENVF" | cut -d' ' -f1)
: > "$STUBLOG"
apt-get install -y "$DEB2" > "$W/upgrade.log" 2>&1 || { cat "$W/upgrade.log" >&2; fail "обновление $VER -> $VER2"; }
[ "$(health_version)" = "$VER2" ] || fail "/healthz после обновления не $VER2"
grep -qE "^record-preinstall $P --from $VER --snapshot db-" "$STUBLOG" || fail "preinst не вызвал record-preinstall (P12): $(cat "$STUBLOG")"
SNAP=$(sed -n 's/.*--snapshot \(db-[^ ]*\).*/\1/p' "$STUBLOG" | tail -n 1)
[ -s "/var/backups/eterix/$P/$SNAP/dump.gz" ] || fail "снимок $SNAP не на диске"
[ "$(sha256sum "$ENVF" | cut -d' ' -f1)" = "$ENV_SUM" ] || fail "обновление переписало конфигурацию (JWT_SECRET — ключ зашифрованных полей)"
if grep -qF "$SETUP_TOKEN" "$W/upgrade.log"; then fail "токен настройки попал в вывод обновления"; fi
TOKEN=$(login)
[ "$(api GET /servers '' "$TOKEN" | json 0.name)" = e2e-keep ] || fail "данные не пережили обновление"
log "обновление $VER -> $VER2: снимок $SNAP, record-preinstall, конфигурация и данные целы"

# --- 3. Восстановление при остановленном стеке (как фаза rollback_stopped движка) --------------
SID=$(api GET /servers '' "$TOKEN" | json 0.id)
api DELETE "/servers/$SID" '' "$TOKEN" >/dev/null
[ "$(api GET /servers '' "$TOKEN" | json 0)" = "" ] || fail "сервер не удалился"
"$H/stop"
if "$C" ps --status running --services | grep -q .; then fail "после хука stop есть работающие контейнеры"; fi
"$H/restore" "$SNAP" || fail "хук restore"
if "$C" ps --status running --services | grep -q .; then fail "restore оставил контейнеры запущенными"; fi
"$H/start"
wait_health "$VER2" || fail "стек не поднялся после restore"
TOKEN=$(login)
[ "$(api GET /servers '' "$TOKEN" | json 0.name)" = e2e-keep ] || fail "restore не вернул данные снимка"
"$H/restore" "no-such-snapshot" 2> "$W/restore.err" && fail "restore несуществующего снимка вернул 0"
grep -q 'не найден' "$W/restore.err" || fail "restore не назвал причину в stderr"
log "restore при остановленном стеке вернул данные; отказ называет причину"

# --- 4. Удаление и purge ----------------------------------------------------------------------
apt-get remove -y $P > "$W/remove.log" 2>&1 || fail "remove"
[ -s "$ENVF" ] || fail "remove удалил конфигурацию"
docker volume inspect ${P}_mongo_data >/dev/null 2>&1 || fail "remove удалил том базы"
if docker ps -a --format '{{.Names}}' | grep -q "^${P}-"; then fail "после remove остались контейнеры"; fi
apt-get purge -y $P > "$W/purge.log" 2>&1 || fail "purge"
[ ! -e /etc/$P ] || fail "purge оставил /etc/$P"
docker volume inspect ${P}_mongo_data >/dev/null 2>&1 || fail "purge удалил том базы — данные удаляются только вручную"
grep -q "docker volume rm" "$W/purge.log" || fail "purge не сказал, как удалить данные вручную"
docker volume rm ${P}_mongo_data ${P}_media_spool ${P}_geoip_db >/dev/null 2>&1 || true
log "remove сохраняет конфигурацию и данные, purge — только данные"
log "ЗЕЛЁНЫЙ"
