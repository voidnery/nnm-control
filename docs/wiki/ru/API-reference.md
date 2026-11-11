# Справочник API

Сгенерирован из описания OpenAPI 3.1 (`/api/v1/openapi.json`) — не правьте вручную, запустите `node backend/scripts/wiki-sync.mjs`. Как пользоваться API — на странице [API](API.md).

## описание

### GET /openapi.json

Это описание.

- Право: без токена

| Ответы | |
|---|---|
| 200 | успех |

## события

### GET /events

Журнал событий — те же конверты, что уходят в webhooks (evt/1).

- Право: `audit.view`
- Параметры: `type` (query), `since` (query), `cursor` (query), `limit` (query)

| Ответы | |
|---|---|
| 200 | успех |
| 400 | неверный запрос: `bad_since` |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 429 | слишком часто, см. Retry-After |

## серверы

### GET /servers

Серверы панели.

- Право: `servers.view`

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 429 | слишком часто, см. Retry-After |

### GET /servers/{serverId}

Один сервер.

- Право: `servers.view`
- Параметры: `serverId` (path)

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 429 | слишком часто, см. Retry-After |

## живые потоки

### GET /servers/{serverId}/streams

Живые потоки на сервере сейчас (кодеки, разрешение, битрейт, источник, время).

- Право: `streams.view`
- Параметры: `serverId` (path)

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 409 | отказ до записи: `not_mapped`, `no_credentials` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `upstream_failed` |

## настройки потоков

### GET /servers/{serverId}/stream-objects/{kind}

Настройки потоков одного вида.

- Право: по виду настроек (см. [API](API.md#права-по-видам))
- Параметры: `serverId` (path), `kind` (path)

| Ответы | |
|---|---|
| 200 | успех: `etag` |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found`, `unknown_kind` |
| 409 | отказ до записи: `not_mapped`, `no_credentials` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `upstream_failed` |

### POST /servers/{serverId}/stream-objects/{kind}

Создать.

- Право: по виду настроек (см. [API](API.md#права-по-видам))
- Событие: `stream_object.created`
- Параметры: `serverId` (path), `kind` (path)
- Тело: `StreamObject`

| Ответы | |
|---|---|
| 201 | создано |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found`, `unknown_kind` |
| 409 | отказ до записи: `not_mapped`, `no_credentials` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `upstream_failed` |

### GET /servers/{serverId}/stream-objects/{kind}/{objId}

Один объект.

- Право: по виду настроек (см. [API](API.md#права-по-видам))
- Параметры: `serverId` (path), `kind` (path), `objId` (path)

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found`, `unknown_kind` |
| 409 | отказ до записи: `not_mapped`, `no_credentials` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `upstream_failed` |

### PATCH /servers/{serverId}/stream-objects/{kind}/{objId}

Изменить только переданные поля.

- Право: по виду настроек (см. [API](API.md#права-по-видам))
- Событие: `stream_object.changed`
- Параметры: `serverId` (path), `kind` (path), `objId` (path), `If-Match` (header)
- Тело: `StreamObject`

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found`, `unknown_kind` |
| 409 | отказ до записи: `not_mapped`, `no_credentials` |
| 412 | объект изменился с момента чтения: `precondition_failed` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `upstream_failed` |

### PUT /servers/{serverId}/stream-objects/{kind}/{objId}

Заменить объект целиком.

- Право: по виду настроек (см. [API](API.md#права-по-видам))
- Событие: `stream_object.changed`
- Параметры: `serverId` (path), `kind` (path), `objId` (path), `If-Match` (header)
- Тело: `StreamObject`

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found`, `unknown_kind` |
| 409 | отказ до записи: `not_mapped`, `no_credentials` |
| 412 | объект изменился с момента чтения: `precondition_failed` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `upstream_failed` |

### DELETE /servers/{serverId}/stream-objects/{kind}/{objId}

Удалить.

- Право: по виду настроек (см. [API](API.md#права-по-видам))
- Событие: `stream_object.deleted`
- Параметры: `serverId` (path), `kind` (path), `objId` (path), `If-Match` (header)

| Ответы | |
|---|---|
| 204 | удалено |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found`, `unknown_kind` |
| 409 | отказ до записи: `not_mapped`, `no_credentials` |
| 412 | объект изменился с момента чтения: `precondition_failed` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `upstream_failed` |

### POST /servers/{serverId}/stream-objects/{kind}/{objId}/actions/{action}

Перезапустить, приостановить, возобновить.

- Право: по виду настроек (см. [API](API.md#права-по-видам))
- Событие: `stream_object.action`
- Параметры: `serverId` (path), `kind` (path), `objId` (path), `action` (path)

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found`, `unknown_kind`, `unknown_action` |
| 409 | отказ до записи: `not_mapped`, `no_credentials` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `upstream_failed` |

## плейлисты

### GET /playlists

Плейлисты, хранимые в панели (без модели).

- Право: `playlist.view`

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 429 | слишком часто, см. Retry-After |

### POST /playlists

Создать.

- Право: `playlist.manage`
- Тело: `PlaylistInput`

| Ответы | |
|---|---|
| 201 | создано |
| 400 | неверный запрос: `name_required` |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 429 | слишком часто, см. Retry-After |

### GET /playlists/{playlistId}

Один плейлист с моделью.

- Право: `playlist.view`
- Параметры: `playlistId` (path)

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 429 | слишком часто, см. Retry-After |

### PATCH /playlists/{playlistId}

Изменить только переданные поля.

- Право: `playlist.manage`
- Параметры: `playlistId` (path), `If-Match` (header)
- Тело: `PlaylistInput`

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 412 | объект изменился с момента чтения: `precondition_failed` |
| 429 | слишком часто, см. Retry-After |

### PUT /playlists/{playlistId}

Заменить название, описание и модель.

- Право: `playlist.manage`
- Параметры: `playlistId` (path), `If-Match` (header)
- Тело: `PlaylistInput`

| Ответы | |
|---|---|
| 200 | успех |
| 400 | неверный запрос: `name_required` |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 412 | объект изменился с момента чтения: `precondition_failed` |
| 429 | слишком часто, см. Retry-After |

### DELETE /playlists/{playlistId}

Удалить.

- Право: `playlist.manage`
- Параметры: `playlistId` (path), `If-Match` (header)

| Ответы | |
|---|---|
| 204 | удалено |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 412 | объект изменился с момента чтения: `precondition_failed` |
| 429 | слишком часто, см. Retry-After |

### GET /playlists/{playlistId}/nimble

Файл, который получит Nimble.

- Право: `playlist.view`
- Параметры: `playlistId` (path)

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 429 | слишком часто, см. Retry-After |

## плейлист на сервере

### GET /servers/{serverId}/playlist

Плейлист на сервере сейчас.

- Право: `playlist.view`
- Параметры: `serverId` (path), `file` (query), `playlistId` (query)

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 409 | отказ до записи: `media_missing`, `unsupported_source`, `refused`, `agent_disabled` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `agent_failed` |
| 504 | агент не ответил: `agent_timeout` |

### POST /servers/{serverId}/playlist

Развернуть плейлист на сервере.

- Право: `playlist.manage`
- Событие: `playlist.deployed`
- Параметры: `serverId` (path)
- Тело: `DeployRequest`

| Ответы | |
|---|---|
| 200 | успех |
| 400 | неверный запрос: `bad_request` |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 409 | отказ до записи: `media_missing`, `unsupported_source`, `refused`, `agent_disabled` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `agent_failed` |
| 504 | агент не ответил: `agent_timeout` |

### POST /servers/{serverId}/playlist/streams/{app}/{stream}/actions/{action}

Остановить или запустить один выходной поток плейлиста.

- Право: `playlist.manage`
- Событие: `playlist.stream_stopped / playlist.stream_started`
- Параметры: `serverId` (path), `app` (path), `stream` (path), `action` (path)
- Тело: JSON

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found`, `unknown_action` |
| 409 | отказ до записи: `media_missing`, `unsupported_source`, `refused`, `agent_disabled` |
| 429 | слишком часто, см. Retry-After |
| 502 | WMSPanel или агент ответили ошибкой: `agent_failed` |
| 504 | агент не ответил: `agent_timeout` |

### GET /servers/{serverId}/playlist/history

Версии, записанные на сервер, новые сверху (без содержимого).

- Право: `playlist.view`
- Параметры: `serverId` (path), `file` (query), `limit` (query)

| Ответы | |
|---|---|
| 200 | успех |
| 401 | нет или неверный токен |
| 403 | не хватает права |
| 404 | не найдено: `not_found` |
| 429 | слишком часто, см. Retry-After |

## События (webhooks)

Каждое событие приходит POST-запросом с подписью — см. [Webhooks](Webhooks.md).

- `stream_object.created`
- `stream_object.changed`
- `stream_object.deleted`
- `stream_object.action`
- `playlist.deployed`
- `playlist.stream_stopped`
- `playlist.stream_started`
- `channel.unhealthy`
- `channel.healthy`
- `agent.offline`
- `agent.online`
- `server.unreachable`
- `server.reachable`
- `stream.up`
- `stream.down`
- `certificate.expiring`
- `webhook.test`
