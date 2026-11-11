# NNM-Control

English · [Русский](../ru/Home.md)

NNM-Control is a web panel for running Nimble Streamer servers: servers and their streams, stream
settings in WMSPanel, playlists, delivery through your own network, LL-HLS, logs and statistics — in one
place, with access rights, an audit log, an API and events.

## Where to start

1. [Getting started](Getting-started.md) — install, first sign-in, connecting WMSPanel and servers.
2. [Servers and agents](Servers-and-agents.md) — add servers and install the agent where playlists and
   logs are needed.
3. [Access](Access.md) — users and roles, turn on 2FA.

## Daily work

- [Streams: settings, transcoders, categories, functions](Stream-settings.md)
- [Playlists](Playlists.md) — Nimble server playlists: build, check, deploy, stop, roll back.
- [Distribution and LL-HLS](Distribution-and-LL-HLS.md) — origin/edge networks, channels, links,
  monitoring, certificates.
- [Dashboard and logs](Dashboard-and-logs.md)

## Automation and integrations

- [Events and reactions](Events-and-reactions.md) — what the panel does on its own and what it reports.
- [API](API.md) — how programs read and change stream settings and playlists.
- [Webhooks](Webhooks.md) — receiving events, checking the signature.
- [API reference](API-reference.md) — every operation.

## When something is wrong

[Troubleshooting](Troubleshooting.md) — common problems and what to do about them.

## Key terms

| Term | What it is |
|---|---|
| **WMSPanel** | Softvelum's cloud panel that holds the settings of Nimble servers. NNM-Control writes changes there through the WMSPanel API (limit: 15 000 calls a day per account) |
| **Nimble's own API** | the management API on the server itself (port 8082). The panel reads state, live streams and statistics from it — without spending the WMSPanel limit |
| **Agent** | a service on the server for file work: playlists, media, logs. Optional |
| **Helper** | a root service on delivery machines and gateways: packages, certificates, nginx |
| **Event** | a record of something that happened (`stream.down`, `playlist.deployed`…) in the `evt/1` format |
