# API

[English](../en/API.md) · Русский

NNM-Control отдаёт программам внешний API — `/api/v1` (контракт `nnm-api/1`). Через него можно
читать и менять настройки потоков на серверах, работать с плейлистами и читать журнал событий.
Всё, что API меняет, попадает в журнал аудита и превращается в событие, которое панель рассылает
по [webhooks](Webhooks.md).

Полный список операций — в [справочнике API](API-reference.md). Машиночитаемое описание OpenAPI 3.1
панель отдаёт сама: `https://<панель>/api/v1/openapi.json` — его можно открыть в Swagger UI или
сгенерировать по нему клиент.

## Токен

Программа входит по API-токену.

1. **Доступ и аудит → API-токены → Новый токен** (нужно право `apitokens.manage`).
2. Название — чтобы потом понимать, кто это: «автоматизация плейаута», «Zabbix», «бот дежурной смены».
3. **Права** — только те, что программе действительно нужны. Выдать можно только права, которые есть
   у вас самих. Права управлять пользователями, ролями, токенами и webhooks токену не выдаются никогда.
4. **Разрешённые адреса** — CIDR через запятую (`10.0.0.0/8, 203.0.113.7/32`); пусто — с любого адреса.
5. **Срок, дней** — пусто — бессрочно.
6. **Выпустить токен** и сразу скопировать: панель хранит только его хэш и больше его не покажет.

Токен выглядит так: `nnm_1a2b3c4d_…` (8 знаков идентификатора и 43 знака секрета). Передаётся в
заголовке:

```
Authorization: Bearer nnm_1a2b3c4d_...
```

- Токен, который больше не нужен или мог утечь, — **Отозвать**: программы с ним теряют доступ сразу.
- В журнале аудита действия токена записаны как `token:<название>#<идентификатор>`, сам токен — никогда.
- На странице видно, когда и с какого адреса токен использовался последний раз.
- Лимит — 600 запросов в минуту на токен. Сверх него — ответ `429` с заголовком `Retry-After`.

Для пробы из браузера подходит и обычный вход в панель: тот же заголовок с токеном сессии работает с
`/api/v1` с правами вашей учётной записи.

## Ответы и ошибки

- Успех — JSON. Списки — `{"items": [...], "next": null}`; `next` — курсор следующей страницы, `null` —
  страница последняя.
- Ошибка — всегда в одном виде:

```json
{ "error": "текст для человека", "code": "код_для_программы", "details": { } }
```

Решения в программе принимайте по `code`: он не меняется внутри v1, текст `error` может меняться.

| Код ответа | `code` | Что значит |
|---|---|---|
| 401 | `unauthorized` | нет токена, токен неверный, отозван, истёк или пришёл с неразрешённого адреса |
| 403 | `forbidden` | у токена нет нужного права (имя права — в тексте) |
| 404 | `not_found`, `unknown_kind`, `unknown_action` | нет такого сервера, объекта, вида или действия |
| 409 | `not_mapped` | сервер не привязан к серверу WMSPanel — настройки потоков недоступны |
| 409 | `no_credentials` | в настройках панели не заданы ключи WMSPanel API |
| 409 | `media_missing`, `unsupported_source`, `refused`, `agent_disabled` | плейлист не записан — см. [Плейлисты](Playlists.md) |
| 412 | `precondition_failed` | объект изменился с тех пор, как вы его прочитали |
| 429 | `rate_limited` | слишком часто |
| 502 | `upstream_failed`, `agent_failed` | WMSPanel или агент на сервере ответили ошибкой; их ответ — в `details` |
| 504 | `agent_timeout` | агент не забрал задачу или не ответил |

## Как не затереть чужую правку

Две программы (или программа и оператор в панели) могут менять один объект одновременно. В WMSPanel
версий нет, поэтому версию даёт панель:

1. `GET` объекта возвращает заголовок `ETag` (в списках — поле `etag` у каждого элемента).
2. Изменение отправляйте с `If-Match: <тот ETag>`.
3. Если объект за это время изменился — ответ `412` с текущей версией в `details.current`. Прочитайте
   её, решите, что делать, и повторите.

Без `If-Match` изменение проходит без проверки. Счётчики (битрейт, состояние, время работы) на ETag не
влияют — меняется он только от настроек.

## Настройки потоков

```
GET    /api/v1/servers                                              серверы панели
GET    /api/v1/servers/{serverId}/stream-objects/{kind}             все объекты вида
GET    /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}     один объект + ETag
POST   /api/v1/servers/{serverId}/stream-objects/{kind}             создать
PATCH  /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}     изменить переданные поля
PUT    /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}     заменить целиком
DELETE /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}
POST   /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}/actions/{restart|pause|resume}
```

Поля объектов — имена WMSPanel API как есть: панель их не переименовывает, поэтому документация
Softvelum к ним применима.

### Права по видам

| `kind` | Что это | Читать | Менять | Действия |
|---|---|---|---|---|
| `udp` | UDP/SRT-выходы | `wmsobjects.view` | `wmsobjects.manage` | — |
| `mpegts-in` | входы MPEG-TS | `wmsobjects.view` | `wmsobjects.manage` | — |
| `mpegts-out` | выходы MPEG-TS | `wmsobjects.view` | `wmsobjects.manage` | pause, resume, restart |
| `republish` | RTMP republish (push) | `republish.view` | `republish.manage` | restart |
| `livepull` | live pull (затягивание потока) | `wmsobjects.view` | `wmsobjects.manage` | restart |
| `hotswap` | hot swap | `wmsobjects.view` | `wmsobjects.manage` | — |
| `apps` | live-приложения | `wmsobjects.view` | `wmsobjects.manage` | — |
| `interfaces` | RTMP-интерфейсы | `wmsobjects.view` | `wmsobjects.manage` | — |

### Пример: заменить источник UDP-потока

```bash
P=https://panel.example.net/api/v1
T="Authorization: Bearer nnm_1a2b3c4d_..."
S=<serverId из GET /servers>

# 1. Прочитать и запомнить ETag
curl -s -D - -H "$T" $P/servers/$S/stream-objects/udp/<objId>

# 2. Поменять только источник
curl -s -X PATCH -H "$T" -H 'Content-Type: application/json' -H 'If-Match: "<ETag>"' \
  -d '{"source_streams":[{"app":"live","stream":"reserve"}]}' \
  $P/servers/$S/stream-objects/udp/<objId>
```

Ответ — объект в новом виде и новый `ETag`. Подписчики webhooks получат событие
`stream_object.changed` с полями «было», «стало» и списком изменённых полей.

## Живые потоки

`GET /api/v1/servers/{serverId}/streams` — что сейчас в эфире на сервере: кодеки, разрешение, битрейт,
источник, время (право `streams.view`). Данные — из WMSPanel и расходуют его суточный лимит вызовов;
не опрашивайте этот адрес чаще, чем нужно. Чтобы узнавать о появлении и пропаже потоков, лучше
подписаться на события `stream.up` / `stream.down`.

## Плейлисты

```
GET    /api/v1/playlists                         плейлисты, хранимые в панели
GET    /api/v1/playlists/{id}                    один, с моделью редактора и ETag
POST   /api/v1/playlists                         создать
PATCH  /api/v1/playlists/{id}                    изменить (If-Match)
PUT    /api/v1/playlists/{id}                    заменить (If-Match)
DELETE /api/v1/playlists/{id}                    удалить (If-Match)
GET    /api/v1/playlists/{id}/nimble             файл, который получит Nimble

GET    /api/v1/servers/{serverId}/playlist?file=…           что на сервере сейчас
POST   /api/v1/servers/{serverId}/playlist                  развернуть
POST   /api/v1/servers/{serverId}/playlist/streams/{app}/{stream}/actions/{stop|start}
GET    /api/v1/servers/{serverId}/playlist/history?file=…   версии, записанные на сервер
```

Права — `playlist.view` и `playlist.manage`. На сервере должен работать [агент](Servers-and-agents.md):
файл плейлиста пишет он.

Развёртывание принимает **ровно одно** из трёх:

```json
{ "playlistId": "<id плейлиста в панели>" }
{ "document": { "Tasks": [ ... ] } }
{ "content": "<текст файла>" }
```

и необязательные `file` (по умолчанию `server-playlist.json`), `force`, `note`. Проверки — те же, что
в панели (см. [Плейлисты](Playlists.md)): испорченный файл не пишется никогда; отсутствующие на сервере
файлы, источники не MP4/MP3, пустой плейлист — отказ `409`, если не передан `"force": true`.

Остановить поток плейлиста `live/news` в файле по умолчанию:

```bash
curl -s -X POST -H "$T" $P/servers/$S/playlist/streams/live/news/actions/stop
```

Запустить обратно (панель возьмёт его описание из истории версий):

```bash
curl -s -X POST -H "$T" -H 'Content-Type: application/json' -d '{"resume": true}' \
  $P/servers/$S/playlist/streams/live/news/actions/start
```

`"resume": true` — продолжить примерно с того места, где остановили; без него поток начинается с
начала блока.

## Журнал событий

`GET /api/v1/events` (право `audit.view`) — те же события, что уходят в webhooks, новые сверху.
Параметры: `type`, `since` (время RFC 3339), `limit` (до 500), `cursor` — значение `next` прошлой
страницы. Удобно, чтобы догнать пропущенное, если получатель webhooks был выключен. Хранятся события
30 дней. Список событий — на странице [События и реакции](Events-and-reactions.md).

## Что гарантируется

- Внутри `v1` — только добавления: новые поля, операции, коды. Ничего не переименовывается и не
  удаляется. Программа должна спокойно пропускать незнакомые поля.
- Несовместимое изменение — это будущий `/api/v2`; `v1` при этом продолжит работать.
