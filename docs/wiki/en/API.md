# API

English · [Русский](../ru/API.md)

NNM-Control gives programs an external API — `/api/v1` (contract `nnm-api/1`). Through it you can read
and change stream settings on the servers, work with playlists and read the event log. Everything the API
changes goes to the audit log and becomes an event the panel sends out over [webhooks](Webhooks.md).

Every operation is in the [API reference](API-reference.md). The panel serves the machine-readable
OpenAPI 3.1 description itself: `https://<panel>/api/v1/openapi.json` — open it in Swagger UI or generate
a client from it.

## Token

A program signs in with an API token.

1. **Access and audit → API tokens → New token** (needs `apitokens.manage`).
2. A name — to know later who this is: "playout automation", "Zabbix", "on-call bot".
3. **Permissions** — only what the program really needs. You can grant only permissions you have
   yourself. Managing users, roles, tokens and webhooks is never granted to a token.
4. **Allowed addresses** — CIDRs separated by commas (`10.0.0.0/8, 203.0.113.7/32`); empty — any address.
5. **Expires in days** — empty — never.
6. **Issue token** and copy it right away: the panel keeps only its hash and will not show it again.

A token looks like `nnm_1a2b3c4d_…` (8 characters of id and 43 of secret). It goes in the header:

```
Authorization: Bearer nnm_1a2b3c4d_...
```

- A token no longer needed or possibly leaked — **Revoke**: programs using it lose access at once.
- The audit log records a token's actions as `token:<name>#<id>`, never the token itself.
- The page shows when and from which address a token was last used.
- The limit is 600 requests a minute per token. Beyond it — `429` with a `Retry-After` header.

For trying things from a browser, an ordinary panel sign-in works too: the same header with the session
token works with `/api/v1` with the rights of your account.

## Answers and errors

- Success — JSON. Lists are `{"items": [...], "next": null}`; `next` is the cursor of the next page,
  `null` — the last page.
- An error always has one shape:

```json
{ "error": "text for a person", "code": "code_for_a_program", "details": { } }
```

Decide in your program by `code`: it does not change within v1, while the `error` text may.

| Status | `code` | What it means |
|---|---|---|
| 401 | `unauthorized` | no token, or the token is wrong, revoked, expired or used from an address that is not allowed |
| 403 | `forbidden` | the token lacks a permission (named in the text) |
| 404 | `not_found`, `unknown_kind`, `unknown_action` | no such server, object, kind or action |
| 409 | `not_mapped` | the server is not mapped to a WMSPanel server — stream settings are unavailable |
| 409 | `no_credentials` | WMSPanel API keys are not set in the panel's settings |
| 409 | `media_missing`, `unsupported_source`, `refused`, `agent_disabled` | the playlist was not written — see [Playlists](Playlists.md) |
| 412 | `precondition_failed` | the object changed since you read it |
| 429 | `rate_limited` | too often |
| 502 | `upstream_failed`, `agent_failed` | WMSPanel or the agent on the server answered with an error; their answer is in `details` |
| 504 | `agent_timeout` | the agent did not pick up the task or did not answer |

## Not overwriting someone else's change

Two programs (or a program and an operator in the panel) can change one object at the same time.
WMSPanel has no versions, so the panel provides one:

1. `GET` of an object returns an `ETag` header (in lists — an `etag` field on every item).
2. Send the change with `If-Match: <that ETag>`.
3. If the object changed meanwhile — `412` with the current version in `details.current`. Read it, decide
   what to do and repeat.

Without `If-Match` the change goes through unchecked. Counters (bitrate, state, uptime) do not affect the
ETag — only settings change it.

## Stream settings

```
GET    /api/v1/servers                                              the panel's servers
GET    /api/v1/servers/{serverId}/stream-objects/{kind}             all objects of a kind
GET    /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}     one object + ETag
POST   /api/v1/servers/{serverId}/stream-objects/{kind}             create
PATCH  /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}     change the fields sent
PUT    /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}     replace entirely
DELETE /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}
POST   /api/v1/servers/{serverId}/stream-objects/{kind}/{objId}/actions/{restart|pause|resume}
```

Object fields are WMSPanel API names as they are: the panel does not rename them, so Softvelum's
documentation applies.

### Permissions by kind

| `kind` | What it is | Read | Change | Actions |
|---|---|---|---|---|
| `udp` | UDP/SRT outputs | `wmsobjects.view` | `wmsobjects.manage` | — |
| `mpegts-in` | MPEG-TS inputs | `wmsobjects.view` | `wmsobjects.manage` | — |
| `mpegts-out` | MPEG-TS outputs | `wmsobjects.view` | `wmsobjects.manage` | pause, resume, restart |
| `republish` | RTMP republish (push) | `republish.view` | `republish.manage` | restart |
| `livepull` | live pull | `wmsobjects.view` | `wmsobjects.manage` | restart |
| `hotswap` | hot swap | `wmsobjects.view` | `wmsobjects.manage` | — |
| `apps` | live applications | `wmsobjects.view` | `wmsobjects.manage` | — |
| `interfaces` | RTMP interfaces | `wmsobjects.view` | `wmsobjects.manage` | — |

### Example: replace the source of a UDP stream

```bash
P=https://panel.example.net/api/v1
T="Authorization: Bearer nnm_1a2b3c4d_..."
S=<serverId from GET /servers>

# 1. Read it and note the ETag
curl -s -D - -H "$T" $P/servers/$S/stream-objects/udp/<objId>

# 2. Change only the source
curl -s -X PATCH -H "$T" -H 'Content-Type: application/json' -H 'If-Match: "<ETag>"' \
  -d '{"source_streams":[{"app":"live","stream":"reserve"}]}' \
  $P/servers/$S/stream-objects/udp/<objId>
```

The answer is the object as it is now and a new `ETag`. Webhook subscribers get a
`stream_object.changed` event with "before", "after" and the list of changed fields.

## Live streams

`GET /api/v1/servers/{serverId}/streams` — what is on air on the server now: codecs, resolution, bitrate,
publisher, uptime (`streams.view`). The data comes from WMSPanel and spends its daily call limit; do not
poll this address more than needed. To learn about streams appearing and disappearing, subscribe to
`stream.up` / `stream.down` instead.

## Playlists

```
GET    /api/v1/playlists                         playlists kept in the panel
GET    /api/v1/playlists/{id}                    one, with the editor model and ETag
POST   /api/v1/playlists                         create
PATCH  /api/v1/playlists/{id}                    change (If-Match)
PUT    /api/v1/playlists/{id}                    replace (If-Match)
DELETE /api/v1/playlists/{id}                    delete (If-Match)
GET    /api/v1/playlists/{id}/nimble             the file Nimble would get

GET    /api/v1/servers/{serverId}/playlist?file=…           what is on the server now
POST   /api/v1/servers/{serverId}/playlist                  deploy
POST   /api/v1/servers/{serverId}/playlist/streams/{app}/{stream}/actions/{stop|start}
GET    /api/v1/servers/{serverId}/playlist/history?file=…   versions written to the server
```

Permissions — `playlist.view` and `playlist.manage`. The [agent](Servers-and-agents.md) must be running on
the server: it writes the playlist file.

A deploy takes **exactly one** of three:

```json
{ "playlistId": "<id of a playlist in the panel>" }
{ "document": { "Tasks": [ ... ] } }
{ "content": "<the file as text>" }
```

plus optional `file` (`server_playlist.json` by default), `force`, `note`. The checks are the panel's own
(see [Playlists](Playlists.md)): a broken file is never written; files missing on the server, sources that
are not MP4/MP3, an empty playlist — `409` unless `"force": true` is sent.

Stop the playlist stream `live/news` in the default file:

```bash
curl -s -X POST -H "$T" $P/servers/$S/playlist/streams/live/news/actions/stop
```

Start it again (the panel takes its definition from the version history):

```bash
curl -s -X POST -H "$T" -H 'Content-Type: application/json' -d '{"resume": true}' \
  $P/servers/$S/playlist/streams/live/news/actions/start
```

`"resume": true` — continue roughly where it was stopped; without it the stream starts from the top of
the block.

## Event log

`GET /api/v1/events` (`audit.view`) — the same events that go to webhooks, newest first. Parameters:
`type`, `since` (RFC 3339 time), `limit` (up to 500), `cursor` — the `next` of the previous page. Handy for
catching up if the webhook receiver was down. Events are kept 30 days. The list of events is on
[Events and reactions](Events-and-reactions.md).

## What is guaranteed

- Within `v1` — only additions: new fields, operations, codes. Nothing is renamed or removed. A program
  should quietly skip fields it does not know.
- An incompatible change would be a future `/api/v2`; `v1` would keep working.
