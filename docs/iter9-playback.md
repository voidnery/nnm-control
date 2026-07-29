# iter9 — playback links: what can be read, and what has to be told

## Why the links were missing

Three separate defects produced the same symptom.

1. The **native-plane** Streams tab never had playback UI at all — it listed
   streams and stopped there.
2. The **WMSPanel-plane** tab had the UI, but gated it on
   `server.playbackEndpoints`, which `wmspanelSync` never populates. Sync sets
   `host` and leaves endpoints empty, so on an auto-synced fleet the watch
   button rendered zero times.
3. Even when an operator filled endpoints in by hand, only HLS and RTMP were
   offered, against the six protocols WMSPanel shows.

## What is a measurement and what is an assumption

| Value | Source | Can it be read? |
|---|---|---|
| Hostnames | `GET /server/{sid}` → `custom_ips[]`, `ip[]` | **yes** |
| RTMP port | `GET /server/{sid}/rtmp/interface` → `port` | **yes** |
| HTTP port (HLS/DASH/SLDP/Icecast/WHEP) | nimble.conf | **no** |

The HTTP port is the whole reason this is not a one-line fix. No endpoint we
have exposes it, so it is a per-server field with Nimble's documented default
of 8081 as the fallback — and when the fallback is used, the playback dialog
says so. An operator who copies a URL is about to paste it somewhere it has to
work; a port labelled "assumed" is actionable, a wrong port presented as fact
is a support ticket.

The same applies to the RTMP port when WMSPanel returns no interface for a
server: default, and marked as one.

## Precedence

1. **Manual** `playbackEndpoints` — if someone typed an address, overriding it
   with a derived one would be worse than useless. Costs no API call.
2. **WMSPanel** — hosts + real RTMP port, HTTP port from the server field.
3. **Panel record** — native plane, missing credentials, or an unmapped
   server: `server.host` with both ports defaulted, clearly labelled.
4. **Nothing** — a server with no address at all resolves to zero endpoints
   rather than to a URL built out of blanks.

Host ranking within (2): `custom_ips` first because those are the names the
operator declared for viewers, then IPv4 from `ip[]`, then IPv6 last — it is
present on some boxes and unroutable from the office on others.

## URL shapes (pinned from Softvelum's published formats)

```
HLS    http(s)://host:httpPort/app/stream/playlist.m3u8
DASH   http(s)://host:httpPort/app/stream/manifest.mpd
SLDP   sldp(s)://host:httpPort/app/stream
WHEP   http(s)://host:httpPort/app/stream/whep.stream
Ice    http(s)://host:httpPort/app/stream/icecast.stream
RTMP   rtmp://host:rtmpPort/app/stream
```

**RTSP is deliberately not offered.** Softvelum's own example uses
`rtsp://host:1937/app/stream` while the publish-side default is 554, and the
port depends on instance settings that no API reports. A guessed RTSP port is
a URL that silently never plays, which is exactly the failure mode this
iteration exists to remove.

## Quota

Two upstream calls per server, cached 10 minutes, `?fresh=1` forces a re-read.
The Streams tab is opened per server rather than per fleet refresh, so this is
nowhere near the collector's budget problem — but it is cached anyway, for the
same reason the transcoder fleet view caches scenario shape. Either call can
fail independently; the surviving half is still used and the failure is
recorded in `notes`.

## Gate note (m1)

`audit:pages` now clicks every enabled button on every page. The reorder bug
existed because a render smoke proves the render path only — a handler naming
an identifier that was never declared is invisible to esbuild and to
`renderToString`, and fails on click alone. The gate was verified against the
real defect before being trusted: with the handler removed it reports
`4 unbound handler(s)` and exits 1.
