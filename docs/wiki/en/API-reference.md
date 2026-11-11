# API reference

Generated from the OpenAPI 3.1 description (`/api/v1/openapi.json`) — do not edit by hand, run `node backend/scripts/wiki-sync.mjs`. How to use the API — see [API](API.md).

## meta

### GET /openapi.json

This description.

- Permission: no token

| Answers | |
|---|---|
| 200 | OpenAPI 3.1 document |

## events

### GET /events

The event log — the same envelopes webhooks deliver (evt/1).

- Permission: `audit.view`
- Parameters: `type` (query), `since` (query), `cursor` (query), `limit` (query)

| Answers | |
|---|---|
| 200 | newest first |
| 400 | `bad_since` |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

## servers

### GET /servers

Servers of the panel.

- Permission: `servers.view`

| Answers | |
|---|---|
| 200 | all servers |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

### GET /servers/{serverId}

One server.

- Permission: `servers.view`
- Parameters: `serverId` (path)

| Answers | |
|---|---|
| 200 | the server |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

## streams

### GET /servers/{serverId}/streams

Live streams on the server now (codecs, resolution, bandwidth, publisher, uptime).

- Permission: `streams.view`
- Parameters: `serverId` (path)

| Answers | |
|---|---|
| 200 | as WMSPanel reports them |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` |
| 409 | `not_mapped` — the server is not mapped to a WMSPanel server; `no_credentials` — WMSPanel API credentials are not set |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `upstream_failed` — WMSPanel refused or did not answer; `details.upstream` holds its answer |

## stream settings

### GET /servers/{serverId}/stream-objects/{kind}

Stream settings of one kind.

Permissions by kind (view / change): `udp` — wmsobjects.view / wmsobjects.manage; `mpegts-in` — wmsobjects.view / wmsobjects.manage; `mpegts-out` — wmsobjects.view / wmsobjects.manage; `republish` — republish.view / republish.manage; `livepull` — wmsobjects.view / wmsobjects.manage; `hotswap` — wmsobjects.view / wmsobjects.manage; `apps` — wmsobjects.view / wmsobjects.manage; `interfaces` — wmsobjects.view / wmsobjects.manage.

- Permission: by kind of settings (see [API](API.md#permissions-by-kind))
- Parameters: `serverId` (path), `kind` (path)

| Answers | |
|---|---|
| 200 | each item carries its `etag` |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found`, `unknown_kind` (details.kinds) |
| 409 | `not_mapped` — the server is not mapped to a WMSPanel server; `no_credentials` — WMSPanel API credentials are not set |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `upstream_failed` — WMSPanel refused or did not answer; `details.upstream` holds its answer |

### POST /servers/{serverId}/stream-objects/{kind}

Create.

- Permission: by kind of settings (see [API](API.md#permissions-by-kind))
- Event: `stream_object.created`
- Parameters: `serverId` (path), `kind` (path)
- Body: `StreamObject`

| Answers | |
|---|---|
| 201 | WMSPanel's answer |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found`, `unknown_kind` |
| 409 | `not_mapped` — the server is not mapped to a WMSPanel server; `no_credentials` — WMSPanel API credentials are not set |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `upstream_failed` — WMSPanel refused or did not answer; `details.upstream` holds its answer |

### GET /servers/{serverId}/stream-objects/{kind}/{objId}

One object.

- Permission: by kind of settings (see [API](API.md#permissions-by-kind))
- Parameters: `serverId` (path), `kind` (path), `objId` (path)

| Answers | |
|---|---|
| 200 | the object |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found`, `unknown_kind` |
| 409 | `not_mapped` — the server is not mapped to a WMSPanel server; `no_credentials` — WMSPanel API credentials are not set |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `upstream_failed` — WMSPanel refused or did not answer; `details.upstream` holds its answer |

### PATCH /servers/{serverId}/stream-objects/{kind}/{objId}

Change only the fields sent.

Example — replace the source of a UDP stream: read it, then send `{"source_streams":[{"app":"live","stream":"new"}]}` with `If-Match`.

- Permission: by kind of settings (see [API](API.md#permissions-by-kind))
- Event: `stream_object.changed`
- Parameters: `serverId` (path), `kind` (path), `objId` (path), `If-Match` (header)
- Body: `StreamObject`

| Answers | |
|---|---|
| 200 | the object as it is now |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found`, `unknown_kind` |
| 409 | `not_mapped` — the server is not mapped to a WMSPanel server; `no_credentials` — WMSPanel API credentials are not set |
| 412 | `precondition_failed` — details.etag, details.current |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `upstream_failed` — WMSPanel refused or did not answer; `details.upstream` holds its answer |

### PUT /servers/{serverId}/stream-objects/{kind}/{objId}

Replace the whole object.

- Permission: by kind of settings (see [API](API.md#permissions-by-kind))
- Event: `stream_object.changed`
- Parameters: `serverId` (path), `kind` (path), `objId` (path), `If-Match` (header)
- Body: `StreamObject`

| Answers | |
|---|---|
| 200 | the object as it is now |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found`, `unknown_kind` |
| 409 | `not_mapped` — the server is not mapped to a WMSPanel server; `no_credentials` — WMSPanel API credentials are not set |
| 412 | `precondition_failed` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `upstream_failed` — WMSPanel refused or did not answer; `details.upstream` holds its answer |

### DELETE /servers/{serverId}/stream-objects/{kind}/{objId}

Delete.

- Permission: by kind of settings (see [API](API.md#permissions-by-kind))
- Event: `stream_object.deleted`
- Parameters: `serverId` (path), `kind` (path), `objId` (path), `If-Match` (header)

| Answers | |
|---|---|
| 204 | deleted |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found`, `unknown_kind` |
| 409 | `not_mapped` — the server is not mapped to a WMSPanel server; `no_credentials` — WMSPanel API credentials are not set |
| 412 | `precondition_failed` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `upstream_failed` — WMSPanel refused or did not answer; `details.upstream` holds its answer |

### POST /servers/{serverId}/stream-objects/{kind}/{objId}/actions/{action}

Restart, pause, resume.

Actions by kind: `mpegts-out` — pause, resume, restart; `republish` — restart; `livepull` — restart.

- Permission: by kind of settings (see [API](API.md#permissions-by-kind))
- Event: `stream_object.action`
- Parameters: `serverId` (path), `kind` (path), `objId` (path), `action` (path)

| Answers | |
|---|---|
| 200 | done |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found`, `unknown_kind`, `unknown_action` (details.actions) |
| 409 | `not_mapped` — the server is not mapped to a WMSPanel server; `no_credentials` — WMSPanel API credentials are not set |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `upstream_failed` — WMSPanel refused or did not answer; `details.upstream` holds its answer |

## playlists

### GET /playlists

Playlists kept in the panel (without the model).

- Permission: `playlist.view`

| Answers | |
|---|---|
| 200 | newest change first |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

### POST /playlists

Create.

- Permission: `playlist.manage`
- Body: `PlaylistInput`

| Answers | |
|---|---|
| 201 | created |
| 400 | `name_required` |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

### GET /playlists/{playlistId}

One playlist with its model.

- Permission: `playlist.view`
- Parameters: `playlistId` (path)

| Answers | |
|---|---|
| 200 | the playlist |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

### PATCH /playlists/{playlistId}

Change only the fields sent.

- Permission: `playlist.manage`
- Parameters: `playlistId` (path), `If-Match` (header)
- Body: `PlaylistInput`

| Answers | |
|---|---|
| 200 | as it is now |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` |
| 412 | `precondition_failed` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

### PUT /playlists/{playlistId}

Replace name, description and model.

- Permission: `playlist.manage`
- Parameters: `playlistId` (path), `If-Match` (header)
- Body: `PlaylistInput`

| Answers | |
|---|---|
| 200 | as it is now |
| 400 | `name_required` |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` |
| 412 | `precondition_failed` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

### DELETE /playlists/{playlistId}

Delete.

- Permission: `playlist.manage`
- Parameters: `playlistId` (path), `If-Match` (header)

| Answers | |
|---|---|
| 204 | deleted |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` |
| 412 | `precondition_failed` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

### GET /playlists/{playlistId}/nimble

The file Nimble would get.

The clean build of the model. A deploy additionally renews the Id of every block whose content changed against the file on that server.

- Permission: `playlist.view`
- Parameters: `playlistId` (path)

| Answers | |
|---|---|
| 200 | Nimble server playlist |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

## server playlist

### GET /servers/{serverId}/playlist

The playlist on the server now.

`exists: false` — no such file (with `alternatives` — the files that are there); `exists: null` — the agent could not be asked (`error`).

- Permission: `playlist.view`
- Parameters: `serverId` (path), `file` (query), `playlistId` (query)

| Answers | |
|---|---|
| 200 | state of the file |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` |
| 409 | refused before anything was written: `media_missing` (details.missing), `unsupported_source` (not MP4/MP3, details.unsupported), `refused` (empty playlist, unreadable media list, stream already there or not there), `agent_disabled` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `agent_failed` — the agent on the server answered with an error |
| 504 | `agent_timeout` — the agent did not pick the task up or did not answer |

### POST /servers/{serverId}/playlist

Put a playlist on the server.

The same checks as the panel: a malformed file is always refused; missing media, non-MP4/MP3 sources, an unreadable media list and an empty playlist are refused unless `force`. The replaced version is kept (GET …/playlist/history). Block Ids are renewed where the content changed, so Nimble picks the change up.

- Permission: `playlist.manage`
- Event: `playlist.deployed`
- Parameters: `serverId` (path)
- Body: `DeployRequest`

| Answers | |
|---|---|
| 200 | written |
| 400 | `bad_request` — malformed file, or not exactly one of playlistId/document/content |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` — server or stored playlist |
| 409 | refused before anything was written: `media_missing` (details.missing), `unsupported_source` (not MP4/MP3, details.unsupported), `refused` (empty playlist, unreadable media list, stream already there or not there), `agent_disabled` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `agent_failed` — the agent on the server answered with an error |
| 504 | `agent_timeout` — the agent did not pick the task up or did not answer |

### POST /servers/{serverId}/playlist/streams/{app}/{stream}/actions/{action}

Stop or start one output stream of the playlist.

Stop removes the task from the file; start puts it back from the version history. Both are deploys with the same checks. A started task plays from the top of its block unless `resume` is asked and possible.

- Permission: `playlist.manage`
- Event: `playlist.stream_stopped / playlist.stream_started`
- Parameters: `serverId` (path), `app` (path), `stream` (path), `action` (path)
- Body: JSON

| Answers | |
|---|---|
| 200 | written |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` — server, or no version holds this stream; `unknown_action` |
| 409 | refused before anything was written: `media_missing` (details.missing), `unsupported_source` (not MP4/MP3, details.unsupported), `refused` (empty playlist, unreadable media list, stream already there or not there), `agent_disabled` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |
| 502 | `agent_failed` — the agent on the server answered with an error |
| 504 | `agent_timeout` — the agent did not pick the task up or did not answer |

### GET /servers/{serverId}/playlist/history

Versions written to the server, newest first (without content).

- Permission: `playlist.view`
- Parameters: `serverId` (path), `file` (query), `limit` (query)

| Answers | |
|---|---|
| 200 | versions |
| 401 | no token, or the token is invalid, expired, revoked or used from an address it is not allowed from |
| 403 | the token or user lacks the permission named in `x-permission` |
| 404 | `not_found` |
| 429 | too many requests for this token (600 a minute unless set otherwise) |

## Events (webhooks)

Every event arrives as a signed POST — see [Webhooks](Webhooks.md).

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
