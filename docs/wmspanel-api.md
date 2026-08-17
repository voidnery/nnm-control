# WMSPanel API inventory

**This file is the answer to "does WMSPanel let us do X".** Read it; do not
recall it. It has three sources, and they cover different halves.

**Read `docs/wmspanel-api-application.md` first for anything about live
applications.** It is the published reference for that section, copied by hand
because the URL is refused to automated readers, and it settles by publication
what the probe below got wrong by omission.

Regenerate the measured half with:

```
node wms-dump.mjs <client_id> <api_key> --probe-writes
```

It writes `wmspanel-api-<date>.md` beside itself. Merge the new table in here.

---

## The documentation covers only half of the API

`wmspanel.com/api_info` is titled *"WMSPanel stats, WMSAuth, Dispersa API"* and
carries an "All" filter above its contents. The Nimble Streamer control
section — republishing, DVR, live pull, MPEG-TS, interfaces — is loaded by
script and is **not in the served HTML**. Fetching the page with a 200,000
token limit ends at the same byte as fetching it with the default: mid-sentence
in the WMSAuth rules section.

So for the Nimble control half, the measured table below is the authority, and
that is not a shortcut — it is the only reading available.

---

## Measured, 2026-08-16, `api.wmspanel.ru/v1`

91 routes, GET and POST on collections, GET and PUT on items. `DELETE` was
never sent: no body makes it harmless, so whether a family accepts it is read
from the documentation instead.

### Account level

| route | GET | POST | PUT (item) | what it is |
|---|---|---|---|---|
| `/server` | 200 | 404 | 200 | servers — the control probe |
| `/streams` | 200 | 403 | — | deep-stats streams |
| `/users` | 200 | 200 | — | users |
| `/data_slices` | 200 | 200 | 200 | data slices |
| `/routes` | 200 | 200 | 200 | routes |
| `/ip_ranges` | 200 | 200 | — | IP ranges |
| `/user_agent_groups` | 200 | 200 | — | user-agent groups |
| `/referer_groups` | 200 | 200 | — | referer groups |
| `/wmsauth/groups` | 200 | 200 | 200 | WMSAuth groups |
| `/dispersa/streams` | 200 | 200 | — | Dispersa monitoring |

### Server level — the Nimble control half

| route | GET | POST | PUT (item) | what it is |
|---|---|---|---|---|
| `/server/{s}/rtmp/republish` | 200 | 200 | 200 | RTMP republishing |
| `/server/{s}/rtmp/interface` | 200 | 200 | 200 | RTMP interfaces |
| `/server/{s}/rtmp/live_pull` | 200 | 200 | 200 | RTMP pull |
| `/server/{s}/rtsp/republish` | 200 | 200 | — | RTSP republishing |
| `/server/{s}/rtsp/interface` | 200 | 200 | — | RTSP interfaces |
| `/server/{s}/rtsp/live_pull` | 200 | 200 | — | RTSP pull |
| `/server/{s}/icecast/interface` | 200 | 200 | — | Icecast interfaces |
| `/server/{s}/icecast/live_pull` | 200 | 200 | — | Icecast pull |
| `/server/{s}/mpegts/incoming` | 200 | 200 | 200 | MPEG-TS in |
| `/server/{s}/mpegts/outgoing` | 200 | 200 | 200 | MPEG-TS out |
| `/server/{s}/hls/republish` | 200 | 200 | — | HLS republishing |
| `/server/{s}/dvr` | 200 | 200 | — | DVR settings |
| `/server/{s}/dvr/settings` | 200 | 404 | 200 | DVR settings, nested |
| `/server/{s}/hotswap` | 200 | 200 | — | hotswap |
| `/server/{s}/live/streams` | 200 | 404 | 404 | live streams, read-only |
| `/server/{s}/live/app` | — | — | — | **live applications — published, see below** |

**The spelling is `interface`, singular** — while the RTSP control API article
calls the method "Get RTSP interfaces list". Guessing from prose is how the
first inventory missed an entire family.

### Not present, on fifteen spellings each

`global`, `settings`, `global_settings`, `defaults`, `applications`,
`application`, `apps`, `interfaces` (plural), `pull`, `outgoing`/`incoming`
outside mpegts, `streams` outside `live/` — for every one of rtmp, rtsp,
mpegts, srt, rist, hls, dash, icecast, sldp, live, transmuxer, udp, ndi, whep.

Those 404s are real. **The conclusion drawn from them was not**: see the
correction below. The list contains `applications`, `application` and `apps`,
and the route is `app`. One letter, for the third time.

---

## Live applications: `/server/{s}/live/app`

**Published**, in `docs/wmspanel-api-application.md`. Full CRUD, and it carries
exactly the fields the inventory concluded were out of reach.

| method | path |
|---|---|
| list | `GET /v1/server/{s}/live/app` |
| one | `GET /v1/server/{s}/live/app/{app_id}` |
| create | `POST /v1/server/{s}/live/app` |
| update | `PUT /v1/server/{s}/live/app/{app_id}` — every field optional |
| delete | `DELETE /v1/server/{s}/live/app/{app_id}` |

Fields that matter here:

| field | meaning |
|---|---|
| `alhls_enabled` | the "Enable Apple's Low-Latency HLS" checkbox. HLS, HLS_MPEGTS and HLS_FMP4 only |
| `hls_part_duration` | part length in ms. **≥ 500** (measured; the reference says 250 and is stale) **and ≤ `chunk_duration` × 1000 ÷ 2** |
| `chunk_duration` | chunk length in seconds, default 6 |
| `chunk_count` | chunks kept, default 4 |
| `protocols` | `HLS`, `HLS_MPEGTS`, `HLS_FMP4`, `RTMP`, `RTSP`, `MPEG2TS`, `ICECAST`, `DASH`, `SLDP`, `WHEP`. All combinable **except HLS with HLS_MPEGTS** |
| `push_login` / `push_password` | credentials for published streams — mask in logs and audit |

### The bounds, measured 2026-08-16

A guarded write probe against `nnm-probe` on NimbleRU-6 settled what the
reference could not:

| sent | answer |
|---|---|
| `{"alhls_enabled":true,"hls_part_duration":500}` | accepted, and the part reads back |
| `{"hls_part_duration":4000}` at chunk 6 | refused — *must be less or equal to 3000 ms* |
| `{"hls_part_duration":100}` | refused — ***must be greater or equal to 500 ms*** |
| `{"chunk_duration":2,"hls_part_duration":500}` | accepted, both in one request |
| `{"chunk_duration":1}` alone, with a 900 ms part set | refused — the server validates the resulting **pair** |
| `{"protocols":["RTMP"]}` | accepted; `alhls_enabled` and the part vanish from the response and return when HLS does |

**The floor is 500 ms, not the 250 published above.** Softvelum's own setup
article agrees: 500 is the smallest their web UI allows, because shorter parts
do not pay for their overhead. Two documents from one vendor disagree and the
server is the one that decides.

Which means a chunk under one second has no legal part at all, and at exactly
one second the only legal value is 500.

**No illegal state is reachable.** The server refuses a chunk change that would
orphan an existing part, so the panel may send the two fields in either order —
though sending them together is proven to work and is simpler.

The rules now live in `backend/src/services/llhls.js`, with each number's
source beside it. The standalone tools carry copies, and
`backend/tests/llhls-rules.test.mjs` fails when the copies drift.

Note also that the failure spelling is lower-case: `{"status":"error"}` with a
`description`. Anything comparing against `'Error'` would read a refusal as a
success. `wmspanelClient.js` compares `!== 'Ok'`, so it is safe.

### How this was missed, twice over

The probe asked `applications`, `application` and `apps`, and never `app`. That
is the same failure as `interface` versus "interfaces list", and it is now the
third instance.

**The route was already in this codebase.** `backend/src/services/
wmspanelClient.js` has had `liveAppList`, `liveAppCreate`, `liveAppUpdate` and
`liveAppDelete` on `/server/{id}/live/app`, with a comment naming the path, and
`backend/src/routes/wmspanelProxy.js` exposes them as `/server/:id/apps`. No
frontend calls them, so they were invisible — and an inventory that probes a
remote API while never reading the client that talks to it can report as
unreachable something the panel already does.

Hence the route census below, and the gate that enforces it.

---

## What this means for LL-HLS

**Both halves are the panel's.** The earlier conclusion here — that the
WMSPanel half was unreachable — is withdrawn.

| half | where it lives | the panel |
|---|---|---|
| container, `alhls_enabled`, `hls_part_duration`, `chunk_duration` | `PUT /server/{s}/live/app/{id}` | **can write it** |
| certificate, `ssl_port`, `ssl_http2_enabled` | `nimble.conf` on the machine | can write it, through plan/apply/rollback |
| whether it actually works | the wire | ALPN `h2` **and** parts in the playlist |

The third row does not become unnecessary because the first two are now
automatable. A player without HTTP/2 falls back to ordinary HLS in silence, so
"both halves applied" is still not evidence of low latency.

---

## Every route the panel calls

Below is every WMSPanel path reachable from `wmspanelClient.js`, reduced to its
family. `backend/tests/wms-inventory.test.mjs` fails if any of them is missing
from this file — because that is precisely the hole `live/app` fell through.

```routes-called
/abr
/aliases
/asn
/dvr_streams
/geo
/ip_ranges
/licenses/transcoder
/origin_apps
/referer_groups
/routes
/server
/server/{s}/hls/settings
/server/{s}/hotswap
/server/{s}/live/app
/server/{s}/live/streams
/server/{s}/mpegts/incoming
/server/{s}/mpegts/outgoing
/server/{s}/mpegts/udp
/server/{s}/rtmp/interface
/server/{s}/rtmp/live_pull
/server/{s}/rtmp/republish
/server/{s}/transmuxer/settings
/streams
/transcoder
/wmsauth/groups
```

Two of those, `hls/settings` and `transmuxer/settings`, are **probes rather
than features**: they exist to ask whether such a family answers, and it does
not. They are declared as such so the gate does not read a 404 route as a
working one:

```routes-probe-only
/server/{s}/hls/settings
/server/{s}/transmuxer/settings
```

---

## The rules

- **Never say a family is read-only** without a status code in a table here.
- **`404` and `405` are different answers.** No such route, versus a route that
  refuses that method. A probe sending one method cannot tell them apart, which
  is how DVR was wrongly recorded as unmanageable for weeks.
- **Write methods live on items**, `PUT /collection/{id}`. An inventory that
  asked the collections filled its write columns with 404s that meant nothing.
- **A `403` on everything including `/server`** means the credentials or the IP
  allow-list — not the API.
- **Before writing that a family is unreachable, `grep` the client.** The
  answer to a week of probing was sitting in `wmspanelClient.js` with a comment
  naming the path. An inventory of somebody else's API that never reads our own
  code can only ever be half an inventory.
- **A spelling list that omits the singular has not been tried.** `interface`,
  not `interfaces`. `app`, not `apps`. Twice is a coincidence; three times is
  the rule above.
- **An empty body does not guarantee refusal.** `PUT` with `{}` returned 200,
  not 400: the request was *executed*, and was harmless only because the
  documentation makes every update field optional. That was luck, not design.
