# Заявка на контракт: внешний API NNM-Control `nnm-api/1` и конверт событий `evt/1`

| | |
|---|---|
| Статус | **принята с правками a–d** (N-0114, 2026-11-10) — внедряется |
| Поручение | T-0049 (эпик 1.32.0, п.2) |
| Дата | 2026-11-10 |
| Где что живёт | `nnm-api/1` (REST, ресурсы, поля, OpenAPI) — документ **продукта**: здесь и `/api/v1/openapi.json`. Конверт событий, заголовки, подпись и правила доставки — общий контракт семейства **`evt/1`**: `eterix-contracts/evt-1.md` (rev.1, draft; ветка `t-0049-evt`, коммит `fca2249`). §3 ниже — только то, что NNM-Control добавляет к `evt/1` |

## 1. Зачем и что уже есть

Оператор: потребители — «все и любые», подключает их оператор в панели; первым делом — **чтение и
изменение настроек всех видов потоков** (например, прочитать источник UDP-потока и заменить его);
webhooks нужны.

Сейчас у панели есть только внутренний API для её же интерфейса (`/api/*`, вход по JWT пользователя,
права — `backend/src/permissions.js`) и Zabbix (`/api/zabbix/*?token=`). Внутренний API меняется вместе
с интерфейсом и обещаний не даёт. Операции над потоками уже реализованы и проверены — новый API
открывает их наружу со стабильным контрактом, а не пишет заново:

| Вид | Сейчас (внутренний маршрут) | Источник истины |
|---|---|---|
| UDP streaming | `/api/wmspanel/server/:id/udp[/:objId]` GET/POST/PUT/DELETE | WMSPanel API |
| MPEG-TS вход / выход | `…/incoming`, `…/outgoing` (+ pause/resume/restart) | WMSPanel API |
| RTMP republish | `…/republish` (+ restart) | WMSPanel API / native |
| Live pull | `…/livepull` (+ restart) | WMSPanel API |
| Hot swap | `…/hotswap` | WMSPanel API |
| Приложения, интерфейсы | `…/apps`, `…/interfaces` | WMSPanel API |
| Транскодеры, ABR, алиасы, origin-приложения | `/api/wmspanel/transcoders`, `/abr`, `/aliases`, `/originapps` | WMSPanel API |
| Живое состояние | `/api/nimble/:id/streams`, `/sessions`, `/srt`, `/status` | native API Nimble |
| Плейлисты | `/api/servers/:id/agent/deploy-playlist`, `playlist-stop`, `playlist-start` | агент на сервере |

## 2. `nnm-api/1` — REST

### 2.1. Общие правила
- Префикс **`/api/v1`**. Внутри v1 изменения только добавляющие (новые поля, ресурсы, события);
  ломающее — `/api/v2`, и v1 живёт рядом не меньше одной мажорной версии продукта. Устаревание —
  заголовки `Deprecation` и `Sunset`.
- JSON, UTF-8. Время — RFC 3339 UTC.
- Списки: `?limit=` (≤ 500) и `?cursor=`; ответ `{items, next}`.
- Описание — **OpenAPI 3.1** по адресу `/api/v1/openapi.json`, из него же раздел API в wiki.
- Ошибки: `{ "error": "<текст человеку>", "code": "<стабильный код>", "details": {…} }`.
  Коды HTTP: 400 неверный запрос, 401 нет/неверный токен, 403 нет права, 404 нет объекта,
  409 конфликт (в т.ч. проверки развёртывания плейлиста), 412 объект изменился (`If-Match`),
  422 недопустимое значение, 429 лимит частоты (+ `Retry-After`), 502 WMSPanel/Nimble/агент не ответили
  или отказали (их ответ — в `details.upstream`).

### 2.2. Доступ — API-токены
- Создаёт пользователь с правом `apitokens.manage` в панели: имя, **набор прав** (подмножество
  существующих `streams.view`, `wmsobjects.manage`, `playlist.manage` … и не шире прав создателя),
  необязательно срок действия и список разрешённых адресов (CIDR).
- Токен показывается **один раз**: `nnm_<8 знаков id>_<43 знака секрета base64url>` (32 байта
  случайных). Хранится только SHA-256 секрета; сравнение — за постоянное время. Префикс `nnm_` —
  чтобы сканеры секретов (gitleaks) узнавали утёкший токен.
- Передача: `Authorization: Bearer nnm_…`. В адресе (`?token=`) — нет.
- Токен не может управлять пользователями, ролями и токенами (эскалация закрыта), не входит в
  интерфейс и не получает JWT.
- Каждый изменяющий вызов — запись в журнал аудита с именем токена; у токена видно время последнего
  использования; отзыв — мгновенный.
- Лимит частоты на токен: по умолчанию 600 запросов в минуту (настраивается).

### 2.3. Ресурсы первой волны

```
GET    /api/v1/servers                                   серверы панели
GET    /api/v1/servers/{serverId}

GET    /api/v1/servers/{serverId}/streams                живые потоки (native API)
GET    /api/v1/servers/{serverId}/stream-objects/{kind}  настройки потоков одного вида
POST   /api/v1/servers/{serverId}/stream-objects/{kind}
GET    /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}
PATCH  /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}    частичное изменение
PUT    /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}    полная замена
DELETE /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}
POST   /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}/actions/{restart|pause|resume}

GET    /api/v1/servers/{serverId}/playlist?file=…        что на сервере сейчас
POST   /api/v1/servers/{serverId}/playlist               развернуть (те же проверки, что в панели)
POST   /api/v1/servers/{serverId}/playlist/streams/{app}/{stream}/actions/{stop|start}

GET    /api/v1/events                                    журнал событий (то же, что уходит в webhooks)
```

Сделано в этапе 3 (1.32.0) сверх списка выше:

```
GET    /api/v1/openapi.json                              описание OpenAPI 3.1 (без токена: данных в нём нет)
GET    /api/v1/playlists                                 плейлисты, хранимые в панели (без модели)
POST   /api/v1/playlists
GET    /api/v1/playlists/{playlistId}                    с моделью редактора и ETag
PATCH  /api/v1/playlists/{playlistId}                    If-Match → 412
PUT    /api/v1/playlists/{playlistId}
DELETE /api/v1/playlists/{playlistId}
GET    /api/v1/playlists/{playlistId}/nimble             чистый файл для Nimble
GET    /api/v1/servers/{serverId}/playlist/history       версии, записанные на сервер
```

Развёртывание (`POST …/playlist`) принимает ровно одно из `playlistId`, `document` (JSON плейлиста
Nimble) или `content` (текст файла) и идёт через тот же `deployHandler`, что и экран панели:
те же проверки, та же история версий, те же события. Отказы — `409` с кодом `media_missing`,
`unsupported_source`, `refused`, `agent_disabled`; агент не ответил — `504 agent_timeout`.

`kind`: `udp`, `mpegts-in`, `mpegts-out`, `republish`, `livepull`, `hotswap`, `apps`, `interfaces`.
Транскодеры, ABR, алиасы, origin-приложения, каналы и сети доставки — вторая волна в том же виде.

- **Поля объектов** — имена WMSPanel API как есть (документируются в OpenAPI по видам); панель их
  не переименовывает, чтобы описание Softvelum оставалось применимым.
- **Конкурентные правки:** `GET` отдаёт `ETag` (хэш объекта), `PATCH/PUT/DELETE` принимают
  `If-Match`; объект изменился — 412 с текущей версией. В WMSPanel версий нет — иначе две
  программы молча затирают друг друга.
- **Пример (UDP-поток, смена источника):**
  `GET …/stream-objects/udp/{objId}` → `ETag: "9c1e…"`, тело с текущими полями; затем
  `PATCH …/stream-objects/udp/{objId}`, `If-Match: "9c1e…"`, тело — только меняемые поля.
- Каждое изменение порождает событие `stream_object.changed` (§3) с полями «было/стало».

## 3. Webhooks — по `evt/1`

Конверт, заголовки `X-Eterix-Event` / `X-Eterix-Delivery` / `X-Eterix-Timestamp` /
`X-Eterix-Signature: v1=<hex HMAC-SHA256(секрет, timestamp + "." + тело)>`, повторы (1 мин … 12 ч,
≈ сутки), «как минимум один раз», отказ от редиректов, обязанности получателя (подпись, окно 5 минут,
дедупликация по `id`) и защита от SSRF — по `eterix-contracts/evt-1.md` rev.1. Здесь — что добавляет
NNM-Control.

### 3.1. Подписка
В панели (право `webhooks.manage`): адрес, секрет (генерирует панель, 32 байта, показывает один раз),
фильтр типов событий, вкл/выкл, отметка «разрешить `http://`». Журнал доставок с повтором вручную.

Куда панель не отправляет (`evt/1` §4.4): loopback (`127.0.0.0/8`, `::1`), link-local
(`169.254.0.0/16`, `fe80::/10`), метаданные облаков, `0.0.0.0`/`::`, multicast и **адреса самой
панели**; частные сети (RFC 1918) разрешены; проверка — после DNS при каждой попытке, редиректы — нет.

### 3.2. Поля конверта у NNM-Control
- `product` = `nnm-control` (slug ERS/1); `type` — без имени продукта (§3.3).
- **`instance.id`** — ULID, создаётся **один раз при первом запуске** панели и хранится в базе
  (коллекция `settings`, поле `instanceId`); не hostname и не адрес. Переживает обновление пакета и
  перезапуск (база — в томе `mongo_data`). Восстановление резервной копии на другой машине переносит и
  его — это одна и та же установка. `instance.name` — из настроек панели (по умолчанию `APP_DOMAIN`).
- `actor`: `user` (вход в панель), `token` (имя API-токена, **не сам токен**), `system` (монитор,
  watchdog, опросы).

### 3.3. Секреты в событиях (`evt/1` §3)
- `data.before` / `data.after` событий `stream_object.*` маскируются: ключи и пароли источников и
  выходов (`*key*`, `*secret*`, `*password*`, `*passwd*`, `*token*`, `*credential*`, учётные данные в
  URL, `Source_AWS`, ключ потока RTMP republish) → `"***"`; факт смены — `data.changed: ["<поле>"]`.
- Токены `nnm_…` **никогда** не появляются в событиях, журнале доставок, журнале аудита и логах
  процесса: в аудит пишется имя токена и его 8 знаков id.

### 3.4. События первой волны (`type`, конверт — `evt/1`)

Сделано в этапе 2 (1.32.0): `stream_object.*`, `playlist.*`, `channel.*`, `agent.*`, `webhook.test`.
Следующий шаг — `server.*`, `stream.*`, `certificate.*`: для них нужны новые опросы.

| type | Когда | Источник в коде |
|---|---|---|
| `stream_object.created` / `.changed` / `.deleted` / `.action` | изменение настроек потока или действие (restart/pause/resume). Из API — `data.before`/`data.after`/`data.changed`; из экранов панели — `data.request` (эти маршруты не читают объект до записи) | `api/v1.js`, `routes/wmspanelProxy.js` |
| `playlist.deployed` / `.stream_stopped` / `.stream_started` | запись плейлиста; `data.renewed_ids`, `data.plays_once`, `data.unsupported` | `deployHandler` |
| `channel.unhealthy` / `.healthy` | проверка доставки канала сменила состояние | `services/deliveryMonitor.js` |
| `agent.offline` / `.online` | агент на сервере перестал/начал отвечать | `services/agentWatchdog.js` |
| `server.unreachable` / `.reachable` | сервер не отвечает API / снова отвечает | опрос статуса (новое) |
| `stream.up` / `.down` | живой поток появился/пропал на сервере | опрос `live streams` (новое, интервал настраивается) |
| `certificate.expiring` | до конца сертификата edge ≤ 20 дней (раз в сутки) | `services/certState.js` (новое расписание) |

## 4. Что меняется где

- **nnm-control:** `/api/v1`, API-токены, webhooks, OpenAPI, раздел wiki; внутренний `/api/*` не меняется.
- **eterix-contracts:** `evt-1.md` rev.1 (draft) — сделано, ветка `t-0049-evt`, `fca2249`, VERSION 1.4.0.
  `nnm-api/1` в контракты не идёт — это API одного продукта.
- **Другие продукты:** ничего; могут стать получателями.

## 5. Решения (N-0114)

1. `evt/1` — общий конверт семейства, draft; NNM-Control — первый производитель.
2. `nnm-api/1` — документ продукта.
3. Входящего канала кроме REST нет: вход — `/api/v1`.
4. 600 запросов в минуту на токен и ≈ сутки повторов — приняты.
5. Публикация OpenAPI наружу — решает оператор; штаб советует вместе с wiki.
6. Правки: a — заголовки и подпись `X-Eterix-*`; b — правила SSRF (§3.1); c — `instance.id` (§3.2);
   d — маскирование секретов и токены вне событий (§3.3).
