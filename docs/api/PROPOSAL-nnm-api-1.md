# Заявка на контракт: внешний API NNM-Control `nnm-api/1` и конверт событий `evt/1`

| | |
|---|---|
| Статус | **предложение** (HO/2 §4.1: публичный REST и формат событий заявляются до внедрения) |
| Поручение | T-0049 (эпик 1.32.0, п.2) |
| Дата | 2026-11-10 |
| Что нужно от штаба | сверка с eterix-contracts; решение, остаётся ли `nnm-api/1` документом продукта или идёт в поезд контрактов; судьба `evt/1` как общего конверта семейства |

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

## 3. Webhooks и конверт `evt/1`

### 3.1. Подписка
В панели (право `webhooks.manage`): адрес, секрет (генерирует панель, показывает один раз), фильтр
типов событий, вкл/выкл. Адрес — `https://`; `http://` только по явной отметке (локальная сеть).
Защита от SSRF: запрещены link-local и метаданные облаков (`169.254.0.0/16`, `fd00:ec2::254`),
адрес проверяется при каждой отправке после DNS.

### 3.2. Доставка
- `POST` JSON (§3.3), заголовки:
  `X-NNM-Event: <type>`, `X-NNM-Delivery: <id>`, `X-NNM-Timestamp: <unix s>`,
  `X-NNM-Signature: v1=<hex HMAC-SHA256(секрет, timestamp + "." + тело)>`.
  Получатель сверяет подпись и отбрасывает запросы старше 5 минут.
- Успех — любой 2xx за 10 с. Иначе повтор: 1 мин, 5 мин, 30 мин, 2 ч, 6 ч, 12 ч (≈ сутки), затем
  «не доставлено». Доставка **как минимум один раз** — получатель дедуплицирует по `id`.
- После 50 подряд неудачных — подписка выключается с записью в журнал и уведомлением в панели.
- Журнал доставок в панели (код, время, ответ — до 2 КиБ), повтор вручную.
- Порядок событий не гарантируется; у каждого — `occurred_at`.

### 3.3. Конверт `evt/1`
```json
{
  "schema_version": "evt/1",
  "id": "01JC8X…",                       // ULID, уникален
  "type": "stream_object.changed",
  "occurred_at": "2026-11-10T12:00:00Z",
  "product": "nnm-control",
  "instance": { "id": "…", "name": "…" },  // какая панель
  "subject": { "kind": "udp", "id": "…", "server_id": "…", "name": "…" },
  "actor": { "kind": "user|token|system", "name": "…" },
  "data": { }                              // зависит от type
}
```
Предлагаю `evt/1` как **общий конверт семейства** (HO/2 §4.1 называет `stream.*`, `server.*`,
`schema_version`): продукту — свои `type` и `data`, конверт и подпись — общие.

### 3.4. События первой волны

| type | Когда | Источник в коде |
|---|---|---|
| `stream_object.created` / `.changed` / `.deleted` | изменение настроек потока — из API или интерфейса; `data.before`/`data.after` | маршруты `wmspanelProxy.js` (+ журнал аудита) |
| `playlist.deployed` / `.stream_stopped` / `.stream_started` | запись плейлиста; `data.renewed_ids`, `data.plays_once`, `data.unsupported` | `deployHandler` |
| `channel.unhealthy` / `.healthy` | проверка доставки канала сменила состояние | `services/deliveryMonitor.js` |
| `agent.offline` / `.online` | агент на сервере перестал/начал отвечать | `services/agentWatchdog.js` |
| `server.unreachable` / `.reachable` | сервер не отвечает API / снова отвечает | опрос статуса (новое) |
| `stream.up` / `.down` | живой поток появился/пропал на сервере | опрос `live streams` (новое, интервал настраивается) |
| `certificate.expiring` | до конца сертификата edge ≤ 20 дней (раз в сутки) | `services/certState.js` (новое расписание) |

## 4. Что меняется где

- **nnm-control:** `/api/v1`, токены, webhooks, OpenAPI, раздел wiki; внутренний `/api/*` не меняется.
- **eterix-contracts:** новый документ `nnm-api-1.md` (или ссылка на OpenAPI продукта) и, если штаб
  согласен, `evt-1.md` — конверт событий семейства. Ломающих изменений в существующих контрактах нет.
- **Другие продукты:** ничего; могут стать потребителями (ServerMonitor, ReZume).

## 5. Вопросы штабу и оператору

1. `evt/1` — общий конверт семейства или пока только NNM-Control?
2. Нужен ли **входящий** канал, кроме REST (например, приём событий от ServerMonitor), или «входы»
   — это и есть `/api/v1`?
3. Лимит 600 запросов в минуту на токен и сутки повторов доставки — подходят?
4. Публикация OpenAPI наружу (на сайте) — сейчас или вместе с wiki?
