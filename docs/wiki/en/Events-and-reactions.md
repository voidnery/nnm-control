# Events and reactions

English · [Русский](../ru/Events-and-reactions.md)

This page answers two questions: what NNM-Control does **on its own**, without an operator, and what it
**reports** — as events you can receive over [webhooks](Webhooks.md) or read through the
[API](API.md#event-log).

## What the panel does on its own

| What | How often | What it does | What it does not do |
|---|---|---|---|
| WMSPanel sync | 15 s after start, then every 10 min | adds new servers, refreshes names, tags, status | does not delete servers or change a host you corrected |
| Agent watchdog | every 30 s | diagnoses; records a change when it repeats 3 times in a row | **does not restart** agents or anything on the servers |
| Watching servers and streams | every 30 s by default (Webhooks page) | asks Nimble's own API whether the server is alive and what is on air | does not spend the WMSPanel limit |
| Certificate check | hourly | looks at the certificates of names viewers reach over HTTPS | renews and reissues nothing |
| Watching delivery channels | if on for the network: every 5 … 1440 min | checks channels on edges as a viewer | does not move viewers or change routes |
| Checks before writing a playlist | on every write | refuses a write that would break the broadcast; renews the `Id` of changed blocks | never writes a broken file, even with `force` |
| Functions | when run | verifies every step; on failure rolls back what was done | does not roll back restart and wait |
| Webhook delivery | every 15 s | retries failed deliveries for about a day | turns a subscription off after 50 failures in a row |
| Metric and log collection | if on in Settings | writes history; the old is removed by itself | — |
| Database backup | every night | `mongodump` into `/var/lib/nnm-control/backups`, the last 14 | skips if there is not enough space |
| Retention | always | audit log, events and deliveries — 30 days; metrics — as set (3 days) | — |

## Events

Every event is an `evt/1` envelope (fields and signature — on the [Webhooks](Webhooks.md) page). `subject`
says what the event is about, `actor` who caused it, `data` the details. Secrets in `data` are replaced
with `***`.

### Stream settings

| Type | When | In `data` |
|---|---|---|
| `stream_object.created` | an object was created (UDP/SRT output, input, pull, push, hot swap, application…) | `after` — what was created |
| `stream_object.changed` | an object was changed | through the API: `before`, `after`, `changed` — list of changed fields; from the panel's screens: `request` — what was sent |
| `stream_object.deleted` | an object was deleted | through the API: `before` |
| `stream_object.action` | restart, pause, resume | `action` |

`subject.kind` — the kind (`udp`, `mpegts-in`, `mpegts-out`, `republish`, `livepull`, `hotswap`, `apps`,
`interfaces`), `subject.server_id` — the server.

### Playlists

| Type | When | In `data` |
|---|---|---|
| `playlist.deployed` | a playlist was written to a server | `filename`, `entries`, `forced`, `missing`, `renewed_ids`, `plays_once`, `unsupported` |
| `playlist.stream_stopped` | a playlist stream was stopped | `filename` |
| `playlist.stream_started` | a playlist stream was started | `filename` |

### Servers and streams

| Type | When | In `data` |
|---|---|---|
| `server.unreachable` | the server stopped answering: N polls in a row without an answer (2 by default) | `server`, `failed_polls`, `error` |
| `server.reachable` | the server answers again | `server`, `down_since`, `down_for_s` — how long it was gone |
| `stream.up` | a live stream appeared on the server — at once | `server` |
| `stream.down` | a live stream has been absent for N polls in a row (2 by default) | `server`, `missed_polls` |

Rules against false alarms:

- Only a **change** is an event. The first poll after the panel starts just remembers how things are.
- A server that has never answered is not "unreachable" — most likely its management address or token is
  not set up (see [Servers and agents](Servers-and-agents.md)).
- While a server is unreachable, its streams are not called down — they simply cannot be seen. If a stream
  is missing once the server is back, `stream.down` follows.
- A stream that blinks and comes back before the Nth miss gives no events.

The poll interval and N are set on **Webhooks → Watching servers and streams**.

### Certificates

| Type | When | In `data` |
|---|---|---|
| `certificate.expiring` | 20 days or less are left (or it has already expired) | `server`, `host`, `port`, `valid_to`, `days_left`, `expired`, `trusted` |

The names viewers reach over HTTPS are checked: the gateway domain and playback endpoints with SSL (not
IP addresses). It is reported at most once a day per name, and a restart of the panel does not repeat it.

### Agents and delivery

| Type | When | In `data` |
|---|---|---|
| `agent.offline` | the agent stopped calling in (confirmed by 3 checks in a row) | `code` — diagnosis, `since_contact_ms` |
| `agent.online` | the agent is back after an announced fault | `code` |
| `channel.unhealthy` | a delivery channel stopped being served on edges | `network`, `ok`, `total`, `codes` |
| `channel.healthy` | the channel is served again | `network`, `ok`, `total` |

### Service

| Type | When |
|---|---|
| `webhook.test` | the **Test** button of a subscription — goes to that subscription only |

## How to use this

- **On-call chat** — a small webhook receiver subscribed to `server.*`, `stream.down`,
  `channel.unhealthy`, `certificate.expiring`, `agent.offline`.
- **Automation** — on `stream.down` your program can switch an output to a reserve source through the
  [API](API.md#stream-settings) (`PATCH` of the object). The panel's functions cannot be run through the
  API yet — an operator runs them.
- **Change tracking** — `stream_object.*` and `playlist.*` with `actor`: who changed what and when,
  programs included.
- A subscription filter can name a group: `stream.*` — every stream event.
