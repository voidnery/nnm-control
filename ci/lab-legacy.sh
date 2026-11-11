#!/usr/bin/env bash
# ci/lab-legacy.sh — проверка выпуска по СТАРОМУ пути (GitHub Pages APT, пакет 1:X.Y.Z, образы ghcr.io) в
# одноразовой ВМ eterix-lab (.eterix-lab/lab.json), ДО публикации.
#
# Старый пакет при установке скачивает образы ghcr.io/voidnery/nnm-control-{api,web}:X.Y.Z, а их до выпуска
# нет. Поэтому внутри ВМ ghcr.io подменяется: образы собираются здесь же из коммита и кладутся в локальный
# реестр с самоподписанным сертификатом на имя ghcr.io (/etc/hosts + /etc/docker/certs.d). Подмена ставится
# ПОСЛЕ установки старой версии с настоящего ghcr.io. Машина одноразовая — так можно только в ней.
#
# Сценарии (LAB_SCENARIO):
#   fresh       — чистая установка 1:X.Y.Z;
#   upgrade     — 1:1.31.1 из публичного APT, данные, затем обновление на 1:X.Y.Z: данные на месте;
#   pull-fails  — диверсия: в реестре нет образа web; обновление обязано НЕ перезапустить службу (старая
#                 версия работает), а после появления образа `dpkg --configure -a` довести его до конца.
# Во всех, где стоит новая версия: /healthz, API v1 и OpenAPI, токен и права, webhook с проверкой подписи,
# журнал событий, страница «Справка» в сборке.
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo -E env "PATH=$PATH" bash "$0" "$@"
cd "$(dirname "$0")/.."

SCEN=${LAB_SCENARIO:-fresh}
VER=$(tr -d '\r\n' < VERSION)
OLD=1.31.1
OWNER=voidnery
P=nnm-control
PORT=8090
PANEL=http://127.0.0.1:$PORT
OUT=${LAB_OUT:-$PWD/lab-logs}
W=$(mktemp -d)
ADMIN_PW="lab-$(openssl rand -hex 8)"
export DEBIAN_FRONTEND=noninteractive
mkdir -p "$OUT"

log() { echo "lab[$SCEN]: $*"; }
fail() {
  echo "lab[$SCEN]: КРАСНЫЙ — $*" >&2
  journalctl -u $P -n 60 --no-pager >&2 || true
  docker ps -a >&2 || true
  exit 1
}
api() { # api METHOD PATH [JSON] [TOKEN] → тело; код — в $W/code
  local args=(-sS -m 15 -o "$W/body" -w '%{http_code}' -X "$1" "$PANEL$2" -H 'Content-Type: application/json')
  [ -n "${3:-}" ] && args+=(--data "$3")
  [ -n "${4:-}" ] && args+=(-H "Authorization: Bearer $4")
  curl "${args[@]}" > "$W/code" || echo 000 > "$W/code"
  cat "$W/body"
}
code() { cat "$W/code"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o;try{o=JSON.parse(s)}catch{o=null};const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],o);console.log(Array.isArray(v)?JSON.stringify(v):v??"")})' "$1"; }
health_version() { curl -fsS -m 5 "$PANEL/healthz" 2>/dev/null | json version; }
wait_for() { # wait_for секунд команда… — пока команда не вернёт 0
  local t=$1; shift
  for _ in $(seq 1 "$t"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1
}
api_up() { [ "$(curl -fsS -m 5 "$PANEL/api/health" | json ok)" = true ]; }
is_version() { [ "$(health_version)" = "$1" ]; }
preseed() { printf '%s\n' "$P $P/domain string panel.lab.test" "$P $P/port string $PORT" | debconf-set-selections; }
setup_admin() {
  local st; st=$(api GET /api/setup/status | json needsSetup)
  [ "$st" = true ] || fail "панель не ждёт первичной настройки"
  api POST /api/setup "{\"token\":\"$(grep '^SETUP_TOKEN=' /etc/$P/$P.env | cut -d= -f2)\",\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" >/dev/null
  [ "$(code)" -lt 300 ] || fail "первичная настройка: HTTP $(code) $(cat "$W/body")"
}
login() { api POST /api/auth/login "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" | json token; }

# ---- 1. Новая версия из коммита: образы и пакет ---------------------------------------------------------
log "собираю образы $VER из коммита ${GITHUB_SHA:-?}"
docker build -q -t "ghcr.io/$OWNER/$P-api:$VER" backend > /dev/null
docker build -q -t "ghcr.io/$OWNER/$P-web:$VER" frontend > /dev/null
bash packaging/build-deb.sh "1:$VER" "$OWNER" "$W/dist" > /dev/null
DEB="$W/dist/${P}_${VER}_all.deb"
[ "$(dpkg-deb -f "$DEB" Version)" = "1:$VER" ] || fail "в пакете не 1:$VER"
log "пакет: $(basename "$DEB") (1:$VER)"

# ---- 2. Старая версия с настоящего ghcr.io (upgrade, pull-fails) -----------------------------------------
if [ "$SCEN" != fresh ]; then
  log "ставлю 1:$OLD из публичного APT"
  curl -fsSL "https://$OWNER.github.io/$P/apt/gpg.key" | gpg --dearmor -o /usr/share/keyrings/$P.gpg
  echo "deb [signed-by=/usr/share/keyrings/$P.gpg] https://$OWNER.github.io/$P/apt stable main" > /etc/apt/sources.list.d/$P.list
  apt-get update -qq
  preseed
  apt-get install -y "$P=1:$OLD" > "$OUT/install-old.log" 2>&1 || { tail -40 "$OUT/install-old.log" >&2; fail "установка 1:$OLD"; }
  wait_for 300 api_up || fail "1:$OLD не поднялась"
  setup_admin
  T=$(login); [ -n "$T" ] || fail "вход в 1:$OLD"
  # Данные, которые обязаны пережить обновление: пользователь (сам вход) и плейлист.
  api POST /api/playlists '{"name":"lab-marker","description":"до обновления"}' "$T" >/dev/null
  [ "$(code)" = 201 ] || fail "плейлист в 1:$OLD: HTTP $(code)"
  # Источник APT убирается: дальше пакет ставится из файла, а подмена ghcr.io не должна мешать apt.
  rm -f /etc/apt/sources.list.d/$P.list
  log "1:$OLD работает, данные записаны"
fi

# ---- 3. Подмена ghcr.io локальным реестром -------------------------------------------------------------
log "подменяю ghcr.io локальным реестром"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=ghcr.io' -addext 'subjectAltName=DNS:ghcr.io' \
  -keyout "$W/reg.key" -out "$W/reg.crt" 2>/dev/null
mkdir -p /etc/docker/certs.d/ghcr.io && cp "$W/reg.crt" /etc/docker/certs.d/ghcr.io/ca.crt
grep -q ' ghcr.io$' /etc/hosts || echo '127.0.0.1 ghcr.io' >> /etc/hosts
docker run -d --name lab-registry -p 127.0.0.1:443:443 -v "$W:/certs:ro" \
  -e REGISTRY_HTTP_ADDR=0.0.0.0:443 -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/reg.crt -e REGISTRY_HTTP_TLS_KEY=/certs/reg.key \
  registry:2 > /dev/null
wait_for 30 curl -fsS --cacert "$W/reg.crt" https://ghcr.io/v2/ || fail "локальный реестр не поднялся"
docker push -q "ghcr.io/$OWNER/$P-api:$VER" > /dev/null
[ "$SCEN" = pull-fails ] || docker push -q "ghcr.io/$OWNER/$P-web:$VER" > /dev/null
# Без этого compose возьмёт образ из локального кэша docker и подмена ничего не проверит.
docker image rm "ghcr.io/$OWNER/$P-web:$VER" > /dev/null 2>&1 || true

# ---- 4. Новая версия ------------------------------------------------------------------------------------
preseed
if [ "$SCEN" = pull-fails ]; then
  log "диверсия: образа web нет — обновление обязано не тронуть работающую версию"
  if apt-get install -y "$DEB" > "$OUT/install-new.log" 2>&1; then fail "установка прошла без образа web"; fi
  grep -q 'NOT restarting the service' "$OUT/install-new.log" || fail "установка не сказала, что служба не перезапущена"
  api_up || fail "старая версия перестала отвечать"
  docker ps --format '{{.Image}}' | grep -q "$P-web:$OLD" || fail "работает не $OLD"
  T=$(login); [ -n "$T" ] || fail "вход в работающую $OLD после неудачного обновления"
  log "старая версия работает; кладу образ web и довожу установку: dpkg --configure -a"
  docker push -q "ghcr.io/$OWNER/$P-web:$VER" > /dev/null 2>&1 || {
    docker build -q -t "ghcr.io/$OWNER/$P-web:$VER" frontend > /dev/null && docker push -q "ghcr.io/$OWNER/$P-web:$VER" > /dev/null; }
  dpkg --configure -a > "$OUT/configure.log" 2>&1 || { tail -40 "$OUT/configure.log" >&2; fail "dpkg --configure -a"; }
else
  apt-get install -y "$DEB" > "$OUT/install-new.log" 2>&1 || { tail -40 "$OUT/install-new.log" >&2; fail "установка 1:$VER"; }
fi
wait_for 300 is_version "$VER" || fail "/healthz не сообщает $VER (сейчас: $(health_version))"
log "работает $VER"

# ---- 5. Что должно работать в новой версии -------------------------------------------------------------
[ "$SCEN" = fresh ] && setup_admin
T=$(login); [ -n "$T" ] || fail "вход в $VER"
if [ "$SCEN" != fresh ]; then
  api GET /api/playlists '' "$T" | grep -q '"lab-marker"' || fail "плейлист, созданный в $OLD, пропал"
  log "данные $OLD на месте"
fi

# OpenAPI — без токена; всё остальное в /api/v1 — с токеном.
[ "$(api GET /api/v1/openapi.json | json openapi)" = 3.1.0 ] || fail "/api/v1/openapi.json"
api GET /api/v1/servers >/dev/null; [ "$(code)" = 401 ] || fail "/api/v1/servers без токена: $(code)"

TOK=$(api POST /api/api-tokens '{"name":"lab","permissions":["servers.view","playlist.view","audit.view"]}' "$T" | json token)
[[ "$TOK" == nnm_* ]] || fail "API-токен не выпущен: $(cat "$W/body")"
api GET /api/v1/servers '' "$TOK" >/dev/null; [ "$(code)" = 200 ] || fail "/api/v1/servers с токеном: $(code)"
api GET /api/v1/playlists '' "$TOK" >/dev/null; [ "$(code)" = 200 ] || fail "/api/v1/playlists: $(code)"
api POST /api/v1/playlists '{"name":"x"}' "$TOK" >/dev/null; [ "$(code)" = 403 ] || fail "токен без playlist.manage создал плейлист: $(code)"
log "API v1: токен и права — как задумано"

# Webhook: приёмник на адресе машины (частная сеть — разрешена), подпись проверяется, как у получателя.
HOSTIP=$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
[ -n "$HOSTIP" ] || fail "нет адреса машины для приёмника"
SUB=$(api POST /api/webhooks "{\"name\":\"lab\",\"url\":\"http://$HOSTIP:9911/hook\",\"allowHttp\":true,\"types\":[]}" "$T")
SID=$(echo "$SUB" | json id); SECRET=$(echo "$SUB" | json secret)
[ -n "$SID" ] && [ -n "$SECRET" ] || fail "подписка: $SUB"
cat > "$W/recv.py" <<'PY'
import hmac, hashlib, http.server, json, sys
secret, out = sys.argv[1].encode(), sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        ts = self.headers.get('X-Eterix-Timestamp', '')
        want = 'v1=' + hmac.new(secret, ts.encode() + b'.' + body, hashlib.sha256).hexdigest()
        ok = hmac.compare_digest(want, self.headers.get('X-Eterix-Signature', ''))
        env = json.loads(body)
        with open(out, 'a') as f:
            f.write(json.dumps({'ok': ok, 'type': env.get('type'), 'id': env.get('id'),
                                'delivery': self.headers.get('X-Eterix-Delivery')}) + '\n')
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(('0.0.0.0', 9911), H).serve_forever()
PY
python3 "$W/recv.py" "$SECRET" "$OUT/webhooks.jsonl" & RECV=$!
trap 'kill $RECV 2>/dev/null || true' EXIT
sleep 1
api POST "/api/webhooks/$SID/test" '' "$T" >/dev/null; [ "$(code)" = 200 ] || fail "тестовое событие: $(code)"
got() { grep -q '"type": "webhook.test"' "$OUT/webhooks.jsonl" 2>/dev/null; }
wait_for 90 got || fail "webhook.test не пришёл за 90 с (доставки: $(api GET "/api/webhooks/$SID/deliveries" '' "$T"))"
grep '"type": "webhook.test"' "$OUT/webhooks.jsonl" | grep -q '"ok": true' || fail "подпись webhook не сошлась"
log "webhook: доставлен, подпись верна"

api GET '/api/v1/events?type=webhook.test' '' "$TOK" | grep -q '"type":"webhook.test"' || fail "события нет в /api/v1/events"

# «Справка»: страницы wiki в сборке фронтенда.
JS=$(curl -fsS "$PANEL/" | grep -o 'assets/[^"]*\.js' | head -n 1)
[ -n "$JS" ] || fail "в index.html нет сборки"
# По маршруту, а не по русскому слову: сборщик может записать не-ASCII экранированным.
curl -fsS "$PANEL/$JS" | grep -q '"/help/:lang/:page"' || fail "в сборке нет маршрута «Справки»"
log "ЗЕЛЁНЫЙ: $SCEN, $VER"
