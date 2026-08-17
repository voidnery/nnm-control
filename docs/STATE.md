# The state of this panel

A single page saying what exists, what was found out the hard way, and what is
deliberately not built. It is here because the alternative kept happening:
proposing to build something the panel already had, or re-deriving a fact about
WMSPanel that had cost an afternoon to establish two iterations earlier.

Read this before designing anything. `CHANGELOG.md` says what changed and when;
this says what *is*.

---

## What the panel is for

Replacing WMSPanel as the operator's interface — not wrapping it. The operator
states intent (channels, networks, who may watch); the panel derives and writes
the Nimble primitives that follow, with the reasoning always one click away.

Everything below serves that, or is a tool for finding out whether it is
working.

---

## Facts about WMSPanel and Nimble, established against live systems

These cost time to find and are wrong in the documentation or absent from it.

| Fact | Consequence |
|---|---|
| A route's `to` is `host:port/path`, **not** a URL | `http://` yields HTTP 200 with `{"status":"Error"}` |
| HTTP 200 does not mean success | The `status` field in the body is the answer |
| `custom_ips` is returned; **custom ports are not** | The panel needs its own copy of `httpPort` — no endpoint reports it |
| Nimble re-streaming is **pull** | An idle edge holds nothing and is healthy, not broken |
| HTTP Origin mode disables the HLS cache | And defeats a WMSAuth signature entirely |
| `server_status` reports cache **sizes**, no hit counters | Hit ratio is not obtainable; amplification is the closest honest metric |
| There is **no access log** — only `nimble.log` | Cache cannot be measured from logs either |
| Nimble emits HLS **and** DASH from one input, unconfigured | Offering both costs nothing on the server |
| LL-HLS needs HTTP/2 over TLS, or players **silently** fall back | So the panel refuses it rather than warning |
| `alhls_enabled` and `hls_part_duration` live on `/server/{s}/live/app` | Both halves of LL-HLS are writable; part ≤ half the chunk |
| `geo` and `asn` are GET-only — no POST | A country restriction cannot be written by any API client |
| `dvr_streams` is GET and DELETE only | Recording is configured in WMSPanel; only playback is ours |
| `ip_ranges` is two objects: a group **and** assigned CIDRs | A group with no CIDRs permits nobody |
| WMSAuth signature: `md5(ip+id+key+time+minutes)` raw → base64 | Time is PHP's `n/j/Y g:i:s A` in UTC; hex-then-base64 is wrong |
| A signed link is bound to the viewer's IP | There is no universal signed link |

Full working in `docs/iter20-nimble-routes.md`.

---

## What exists

**Delivery networks.** Servers with roles (ingest / origin / mid / edge /
gateway), upstream wiring, geography with an offline DB-IP database, and a
globe. Setup is one screen of five ordered steps, each knowing whether it is
done from real data rather than from a checklist.

**Channels.** An application and a stream, delivered by one network. Carries
its packaging (HLS / LL-HLS / DASH) and its protection. Discovery offers
streams the origins publish that are not channels yet.

**Derivation.** The operator's intent becomes Nimble routes and WMSAuth /
referer / IP-range objects. Every derived item carries why it exists and where
its address and port came from. The same computation drives the preview and the
apply, deliberately: two would drift, invisibly, until an apply did something a
preview had not shown.

**Links.** A production link through the configured mode and policy, test links
straight at each edge, signed links for token-protected channels, and replay
links into the DVR archive. Each says what it exposes and what it is bound to.

**Verification.** The panel fetches a playlist as a viewer would — the only
honest test in a pull model — records the result, and can do it on a schedule
per network (off by default). History gives availability over a window, with
partial and total failures counted apart.

**Agents.** Ticket-based install with a progress bar and named stages, agent
v24, a readiness report per machine, and a report of which processes hold ports
80 and 443 — with the systemd unit where there is one, because a unit is
stopped by name and a bare process is not. All of it reads; none of it writes.

**A privileged helper, and the reason it is separate.** The agent proper runs
as its own user under `ProtectSystem=strict` and cannot install packages or
write `/etc`. That is deliberate and stays: on fifteen media servers it needs
two directories, and an agent that could install packages would be root across
the fleet the moment the panel is compromised — and the panel is reachable over
plain HTTP.

So system changes live in a second unit, `nnm-agent-privileged`, installed
only on machines whose purpose is `gateway`. The SSH install already runs as
root, so on those machines it goes in with the agent rather than being a second
thing to remember; on every other purpose the block is **absent from the
script** rather than skipped at runtime — a block that exists and is disabled is
one somebody can enable by accident. The purpose is captured on the enrolment
ticket, because the install URL is unauthenticated by design and there is no
server to look up at fetch time. It runs as root and
is scoped by `ReadWritePaths` to ten directories: nginx, certbot and apt's
state. Full control of the panel then buys nginx and certbot — not
`/etc/passwd`, not `/root/.ssh`, not a Nimble configuration. It binds loopback,
it is its own unit with its own lifetime, and removing it is one command.

The allow-lists exist twice on purpose — in the panel's plan and in the helper
itself — because the plan is composed by the panel and the panel is the thing
that might be compromised. A check keeps the two equal.

**Gateway preparation, end to end.** Given a domain and a mode, exactly what
would be run and written — the argv and the file bytes, not a description —
then applied by the agent, verified by TLS handshake rather than by exit codes,
and reversible from the backups the apply itself reports. The plan is
recomputed at apply and compared: if the machine moved between the preview and
the press, the operator approved something else.

The agent executes steps it is sent and composes none: package, file or
command, from a fixed set of shapes. Anything else would be a remote shell with
extra ceremony.

---

## What is deliberately absent

| Not built | Why |
|---|---|
| Cache hit ratio | Nimble reports no counters. Amplification is offered instead and is not called hit ratio |
| Country restriction, written | No POST exists. The mode is offered, marked, and refused at apply |
| DVR recording setup | No POST exists. Playback links only |
| WebRTC | Every viewer is a session; it does not cache and breaks the pull-cache topology |
| Viewer metrics (time to first frame, rebuffer) | Needs instrumentation in the player, not the servers |
| Bandwidth between nodes | Probes measure latency and reachability only |
| Two origins with failover | The model allows two upstreams; the arbiter takes the first and says so |
| ABR ladders as channel properties | Read, not derived |

---

## Open, waiting on something other than code

- **TLS on the edges** — verified absent on RU-2 by handshake. LL-HLS is
  impossible until it exists. A gateway now gets TLS as part of preparation;
  an edge does not, because an edge already runs something on those ports.
- **Redirect delivery, working and observed.** `cdn-test-5` answers 302 with a
  `location` naming the chosen edge, and the viewer then talks to that edge
  directly — confirmed on the edge's own resource monitor, which is the only
  place the difference shows. In a player the two modes are identical: it
  follows the 302 without saying so.

  Both modes are now proved end to end on the same machine, and switching
  between them rewrites its nginx from the panel.
- **Delivery through an edge-proxy, working.** `cdn-test-5` serves
  `https://cdn-test-1.bbesport.com/<app>/<stream>/playlist.m3u8` and forwards to
  the three Nimble edges of the network. The viewer's link names the gateway
  and nothing else — the edges' addresses do not appear in it, which is the
  whole difference between proxy and redirect.

  Its nginx is kept current by the panel: adding or removing an edge rewrites
  the config through the privileged helper, in the same request as the save.
  The panel reports the edge count it wrote, and that number is worth reading —
  a rewrite reporting **0** is a config forwarding nowhere, which is how the
  last defect announced itself while looking like success.
- **A redirect is an address somebody else will dial**, so every part of it
  must be true of the machine at the other end — including the scheme. The
  viewer'"'"'s scheme is not that machine'"'"'s: a viewer on https was sent to
  `https://<edge>:8081`, which speaks plain HTTP, and the connection died at the
  handshake. TLS on an edge comes from the panel'"'"'s own probe, not from an
  `httpsPort` being filled in. Proxy mode hides this class entirely, since it
  dials the edge itself.

- **Two gateway modes, and they are told apart by the HTTP response.** Proxy
  answers 200 and carries the media; redirect answers 302 and hands over an
  address. A player follows a 302 without saying so, so both look identical on
  screen — which is how a machine served proxy for a day while the panel said
  redirect. `curl -sI` on the viewer URL is the only honest check.

- **A gateway, prepared end to end and proved.** `cdn-test-5` (89.125.121.218)
  was taken from a bare Ubuntu 24.04 to a working TLS gateway for
  `cdn-test-1.bbesport.com` by the panel: nginx and certbot installed, a
  certificate issued through the challenge, the configuration written, tested
  and reloaded — thirteen steps, then a TLS handshake from the panel that
  reported h2 negotiated. The last line is the one that matters: success is
  read from being a client, not from thirteen exit codes.
- **Naming.** A machine that carries delivery without Nimble is an
  **edge-proxy**: it terminates TLS on one name and hands viewers on, and it is
  a different thing from a Nimble edge, which serves video from those same
  ports. The two are listed apart wherever a machine is chosen, because one
  list invites putting a gateway on a media server without noticing.
- **LL-HLS on the edges** — the same envelope applied to `nimble.conf` is not
  written yet, and neither is the `live/app` write. TLS on an edge is what the
  first waits for; the second waits for nothing but a reading of real
  applications from the fleet.
- **Agent fleet** — seven machines run the agent, all on v28 and all polling:
  `selectel(24/7)` (origin), the three edges `Nimble RU-2`, `NimbleRU-3` and
  `NimbleFIN-1`, plus `NimbleRU-5`, `Сердце Пальмиры` and the edge-proxy
  `cdn-test-5`. The other nine are read by direct dial.

  An earlier version of this line said the edges had no agent. That was true
  once and stopped being true without the line changing, and I repeated it as
  fact for several sessions — including in a list of what to build next. A note
  about the fleet is a claim about a machine, and it goes stale exactly like
  any other reading from one. Checked against the database on 2026-08-16.

---

## Habits that earned their place

**Gates are proven by contradiction.** A check nobody has watched fail is a
check that might be testing nothing. Roughly one in three, on first writing,
turned out to pass against the fault it was written for — most often because it
was bound to a name or an arrangement rather than to an outcome.

**Bind gates to outcomes.** Six times a gate went red about code that had got
better, because it named a mechanism that had moved. The rule survives the
implementation; assert the rule.

**"Could not find out" is never "missing".** Three separate incidents came from
folding them together: an unread route list reading as no routes, an unasked
agent as an absent capability, an unchecked delivery as a failed one.

**A route is only real once both halves are joined.** A path declared on a
mounted router, and a path called from the client, live in different files and
are checked by nothing that reads only one of them —  reads the
mounts, the declarations and the call sites together.

**Verify the archive from a clean extraction.** Eight gates once passed only in
the directory they were authored in. It also once recovered a file this work
had truncated to zero.

The full directive-by-directive analysis of the helper's unit is in
`docs/privileged-helper.md`, written after the fifth attempt. Read it before
touching that unit.

**Two scripts that run on the same machine must agree about it, and a gate has
to make them.** The privileged helper cost three releases in a row by assuming
a path the agent's installer had decided differently — first the agent binary,
then the environment variable names, then node. Each looked correct in
isolation; each failed only on a real machine. The checks now read
`STATE_DIR` out of the installer and require the helper to contain what it
builds, so the next divergence fails in the suite rather than on somebody's VM.

**Anything that grows needs a ceiling, expressed in the unit that binds.** The
panel filled its own 96 GB disk and took three projects down with it. Four
limits existed and none held: audit retention counted days while agent polls
wrote 8.6 million rows, backup retention counted files while the database grew
thirtyfold, container logs had no limit at all, and mongodump wrote until the
disk ran out instead of refusing. Each was reasonable when written and wrong
about a subject that had changed. `test:retention` now checks the ceilings —
including that a cap is a number that binds rather than a variable that exists.

**A machine the panel configured, the panel keeps current.** An edge-proxy'"'"'s
nginx names the edges it forwards to, so changing which machines are edges
changes what that file must say. The panel rewrites it on save, through the
privileged helper that installed nginx there in the first place — no
credentials are stored and none are needed. Detecting the drift and asking the
operator to press a button elsewhere was the panel declining to do its job. It
touches only machines already prepared, writes only the config, and an
unreachable machine is reported rather than failing the operator'"'"'s edit.

**An address comes from the operator.** The Host field on a server outranks
anything synced from WMSPanel: WMSPanel'"'"'s domains are a fact about WMSPanel,
and the Host field is a person saying where the machine is. Where a machine has
several addresses, all of them are offered rather than one being chosen — the
panel cannot know which name resolves correctly today.

**Anything read from a machine is stamped.** A fact about TLS or delivery from
last week is not a fact about now, and a green mark that stopped being true is
worse than an empty one.

## Why the version jumped from 0.99.26 to 1.8.6

There is a stray package in the apt pool:

    1.8.5 500  https://voidnery.github.io/nnm-control/apt stable/main

It predates this scheme and nobody is going to remove it from a published
repository. Every release since has carried a Debian epoch — `1:0.99.26` — for
one reason: apt compares the epoch first, so `1:0.x` outranks a bare `1.8.5`
that would otherwise win every upgrade.

That worked, and it hid something. **1.0.0 sits below 1.8.5.** The moment the
version scheme reached 1.x, the epoch stopped being a convenience and became
the only thing standing between an upgrade and a rollback to a package nobody
maintains. Anyone later reasoning "we are on 1.x now, the epoch is noise" would
be right about the shape and wrong about the pool.

So the version continues from **1.8.6**: above the stray package on its own
merits, with the epoch as a second line rather than the only one. Nothing about
the numbering means anything else — there is no 1.1 through 1.8, and no release
was skipped.

The epoch stays. Removing it is a separate decision, and it should be taken by
somebody looking at the pool rather than at the version string.

## The release tag is created last, not first

An earlier note here claimed the opposite, and it was wrong: the workflow tags
in its final step, after the apt repository is published, precisely so a run
that fails halfway leaves no tag behind. Nothing else in the repository creates
tags.

So `v1.0.0` and `v1.8.7` existing without packages behind them is not
explained by the ordering, and the cause is still unknown. What is known: a
release finishing in seconds instead of minutes did not run, the tag is why it
skipped, and `apt-cache policy nnm-control` is the authority on what exists.

The superseded note follows, kept because the reasoning in it is what led to
checking the file rather than acting on it.

## Superseded: a release tag is created before the release is published

The workflow tags `vX.Y.Z` and then builds. A run that stops after the tag —
for any reason — leaves the tag behind, and every later run reads it as "this
version is already out" and skips everything. Thirteen seconds, green tick,
nothing published.

It has happened twice: `v1.0.0` and `v1.8.7` are both tagged with nothing in
the pool behind them.

The fix is to tag after publishing, and it has not been made yet — the delivery
path was worth more at the time. Until then:

* a release that finishes in seconds instead of minutes did not run;
* `git ls-remote --tags <repo> | grep vX.Y.Z` confirms it;
* deleting the tag and pushing again releases it, or bumping to the next
  version sidesteps it.

Neither `v1.0.0` nor `v1.8.7` corresponds to a published package. They are dead
tags, and `apt-cache policy nnm-control` is the authority on what exists.

## The audit log, swept

The panel filled its own 96 GB disk with its own audit rows: every agent poll
was recorded until v0.99.20. The source is closed, and the history was removed
from the panel itself — 10.6 million rows in two passes, `50,653 MB → 4 MB`.

What the operation is made of is worth keeping, because the next bulk operation
in this panel will need the same parts:

* **The count is an estimate**, sampled and scaled. Counting 8.6 million
  documents by regular expression took minutes and returned HTTP 504.
* **The work is a job**, answered 202 and polled. Deleting and compacting takes
  minutes too, and a held-open request is at the mercy of whatever proxies the
  panel.
* **Deleting rows returns no disk.** WiredTiger keeps the file; `compact` gives
  it back, holds a lock while it does, and the panel says so.
* **Commands go through `db.getClient().db(name)`.** `Model.db` is a Mongoose
  Connection and has no `.command()` — calls to it throw, and a `catch` turns
  that into a plausible-looking failure.

## Two views of an edge

A check from the panel answers "could a viewer get this" and nothing more.
Nimble refusing, the machine's firewall, the route between and the panel's own
network are indistinguishable from outside, and they are four different
repairs.

An agent on the edge asks the same question over loopback, where none of those
can intervene. The pair is what carries the meaning:

| inside | outside | what it is |
|---|---|---|
| serving | reachable | working |
| serving | not reachable | the path, not Nimble |
| not serving | not reachable | Nimble is not serving this |
| not serving | reachable | the two checks are asking different questions |

The last row is kept deliberately. A combination that cannot happen means the
comparison is wrong, and reporting it as a verdict about the machine would be
worse than saying nothing.

**A playlist is read twice.** One fetch cannot tell a live stream from a file a
dead one left behind — 200 on a frozen playlist is the most convincing wrong
answer this check could give.

**Cache is measured as amplification**, bytes out over bytes in, because Nimble
exposes no hit counters at all — confirmed against the fleet. An idle edge
measures nothing and is healthy: a pull cache with no viewers pulls nothing,
and calling that a cache failure is the conflation the whole design avoids.
Occupancy comes from different fields and survives when traffic cannot be
measured.

## Reconnaissance scripts have their own rules

`docs/recon-scripts.md`. A script that is copied to a machine and run once must
import nothing, take its inputs on the command line, write its report beside
itself whichever way the run ends, and be read-only unless a flag says
otherwise. Each of those was paid for by a script that failed on its first run.

## What the WMSPanel API can do lives in one file

`docs/wmspanel-api.md`, regenerated by `backend/tools/wms-dump.mjs`. Any claim
about what that API allows is read from there and not from memory.

The rule exists because memory was wrong. This document recorded that DVR could
not be managed through the API. **It can** — confirmed 2026-08-16:
`/server/<id>/dvr` answers GET and POST, `/server/<id>/dvr/settings` answers
GET, PUT and DELETE. The probe behind that note sent `GET`
and `DELETE`, found no `POST`, and "we did not find a write method" became
"there is no write method" — a conclusion from an incomplete test, repeated for
weeks and used to decide what to build. `geo`, `asn` and the transmuxing
settings were recorded the same way and are suspect until the inventory says
otherwise.

`404` and `405` are the distinction that matters: no such route, versus a route
that refuses that method. A probe sending one method cannot tell them apart.

## LL-HLS: both halves are reachable

**Corrected 2026-08-16.** This section previously said the WMSPanel half was
not in the API. It is: `/server/{s}/live/app`, full CRUD, published in
`docs/wmspanel-api-application.md`.

| half | where it lives | can the panel do it |
|---|---|---|
| container, `alhls_enabled`, `hls_part_duration`, `chunk_duration` | `PUT /server/{s}/live/app/{id}` | **yes** |
| certificate, `ssl_port`, `ssl_http2_enabled` | `nimble.conf` on the machine | **yes** — a file the agent already writes |
| proof that it works | ALPN `h2` plus parts in the playlist | **yes**, and still required |

**`hls_part_duration` must be ≥ 500 ms** — measured, not the 250 the API
reference publishes — **and ≤ `chunk_duration` × 1000 ÷ 2.** A chunk under one
second therefore has no legal part at all.

### How the wrong version of this section survived

Two failures, stacked:

- The probe asked `applications`, `application` and `apps`. The route is `app`.
  Fifteen spellings across fourteen protocols, and the singular was not among
  them — the same shape as `interface` versus "interfaces list", now the third
  instance.
- **The route was already in this codebase.** `liveAppList` / `Create` /
  `Update` / `Delete` in `wmspanelClient.js`, on `/server/{id}/live/app`, with
  a comment naming the path, exposed at `/server/:id/apps` in
  `wmspanelProxy.js`. Nothing in the frontend calls them, so they were
  invisible, and an entire investigation ran past them.

The gate that follows from it: `backend/tests/wms-inventory.test.mjs` requires
every path in `wmspanelClient.js` to appear in `docs/wmspanel-api.md`. A route
the panel can call and the inventory does not mention is now a failing test,
not a discovery six weeks later.

This is also why "measured, not proven" was the right label and the wrong
comfort. The measurement was sound; the names it measured were chosen by the
same guess that had already failed twice.

---

## The fleet's live applications, read 2026-08-16

103 applications across 14 servers, every one reachable at
`/server/{s}/live/app` with a 200, item route included.

| what | reading |
|---|---|
| `alhls_enabled` present | 89 of 103 |
| applications carrying an HLS-family protocol | 89 of 103 |
| the two sets | **identical, no exception** |
| LL-HLS enabled anywhere | none |
| `hls_part_duration` returned anywhere | never |
| `chunk_duration` | 96 × 6 s, 6 × 2 s (NimbleEU-Tunnel), 1 × 100 s (`testZaderj`) |
| containers in use | plain `HLS` only — no `HLS_FMP4`, no `HLS_MPEGTS` anywhere |

**The field is conditional, not absent.** `alhls_enabled` comes back for
exactly those applications that carry HLS, HLS_MPEGTS or HLS_FMP4, and for no
others. That matches what the reference says the field applies to. So the 14
applications without it are not on an older version — they are RTMP-only, and
enabling LL-HLS on one means first putting HLS into its `protocols`.

**The chunk is not an obstacle. That claim is withdrawn.** An earlier version
of this section said 85 of the 89 candidates needed their chunk lowered from 6
to 2 seconds. It was inferred from "the ceiling at chunk 6 is 3000 ms" and
never checked against a source. Softvelum's setup article recommends a part of
2000 ms **at a chunk of exactly 6 seconds**, giving about 6 seconds of latency;
1000 ms gives 4–5; 500 ms — the lowest their UI allows — gives about 2. The
fleet's chunk is already the recommended one.

**The container is the real gap.** All 89 candidates carry plain `HLS`, which
the vendor describes as optimised for **audio-only** low-latency streams. For
video they highly recommend `HLS_FMP4` (CMAF) — the only container that gets
the full benefit and the only one supporting HEVC — and explicitly discourage
`HLS_MPEGTS` for LL-HLS. Not one application in the fleet carries `HLS_FMP4`.
Whether adding it changes the playback path is unmeasured.

### The DASH path is confirmed

**Measured 2026-08-17**, `nnm-probe/feed1` on NimbleRU-6 with protocols HLS,
DASH, SLDP: `GET /manifest.mpd` → 200, a 1786-byte MPD. The `pathUnverified`
flag `protocols.js` carried on DASH since it was written is gone, removed by a
fetch rather than by the documentation starting to look trustworthy. No
protocol claims an unverified path now.

The same run also showed the fleet's ordinary shape: a master with one variant
at `chunks.m3u8`, MPEG-TS segments, no parts.

### `HLS_FMP4` replaces plain HLS — it does not join it

**Measured 2026-08-17** on `nnm-probe` (NimbleRU-6), which held HLS, DASH, SLDP:

```
PUT {"protocols":["HLS","DASH","SLDP","HLS_FMP4"]}   → status Ok
GET                                                   → HLS_FMP4, DASH, SLDP
```

Plain HLS is gone, and the API reported success. The reference names only
HLS + HLS_MPEGTS as an illegal pair and says the rest combine freely; on this
deployment fMP4 takes plain HLS's slot.

**So there is no "adding fMP4".** There is only switching to it, and on a live
application that is every current viewer's container changing under them.
`llhls.js` carries `protocolsAfterWrite()` so the panel can show what a write
will actually store, rather than discovering it in a readback.

### Switching container: the link holds, the stream restarts

**Measured 2026-08-17** with the input restarted inside the window — media
sequence 333 → 10, so a genuine restart and not a guess:

| | entry point | variant | container |
|---|---|---|---|
| before | `/playlist.m3u8` | `chunks.m3u8` | MPEG-TS |
| after | `/playlist.m3u8` | `video.m3u8` | fMP4 |

**The entry point does not move.** `playlist.m3u8` is what `channelLinks`
builds and what an operator hands out, and it resolved before and after. The
variant behind it is renamed, and a player finds it by following the master —
which is what a player does anyway.

So this is **not a link migration**. It is an operation with an interruption:
the switch only takes effect once the input stream restarts, and a restart ends
every session in flight regardless of what the variant is called. The form
should present it that way — a short outage on that application, not a
re-issuing of links.

And the reverse holds, which is easy to forget: **putting the protocols back
does not put the output back.** The running stream keeps the container it was
restarted with until it is restarted again.

### Superseded: whether `HLS_FMP4` moves the playback path

The first attempt answered nothing, twice over.

- The probe compared raw URIs, and Nimble mints a `nimblesessionid` per
  request. `chunks.m3u8?nimblesessionid=1` versus `…=3` read as one path gone
  and another appeared, and the run printed the alarming verdict — that adding
  the container had moved existing viewers. **Nothing had moved.** Fetching and
  comparing are two jobs and the URI is not the right key for both.
- Under that, the real result was *no observable change* — and the vendor says
  the input stream must be restarted before Nimble produces the new output. A
  stream that was already running was still being packaged the old way. So "no
  change" could not be told from "the setting had not taken effect".

Both are fixed in the tool: volatile parameters leave the comparison, the write
is read back before anything is concluded from it, and the wait is a window the
operator is told to restart the stream inside.

The second run, with a 90-second window, still showed nothing moved and the
container still MPEG-TS — but there was no way to know whether the stream had
been restarted. So the tool now reads the **media sequence**: a stream that
kept running has a higher one, a restarted stream starts over, and a sequence
that has not moved at all is a stalled playlist and answers nothing. Three
outcomes, and the third is not rounded up to the convenient one.

### Three things the API cannot do for us

- **The input stream must be restarted** after LL-HLS is enabled, or Nimble
  keeps producing ordinary output. The panel has `livePullRestart` for pull
  sources and nothing at all for a stream somebody publishes into Nimble — so
  for those it must say the write is not yet in effect rather than report done.
- **Keyframe alignment is on the encoder.** At a 6 s chunk the vendor gives two
  examples and no rule: a 1000 ms part allows intervals of 1, 2 or 3 seconds; a
  2000 ms part also allows 6. Misalignment does not fail loudly — chunks come
  out at 4.3, 5.0, 10.0 seconds and some players simply misbehave.
- **Interleaving compensation** with a minimum delay of zero is recommended for
  video+audio at low latency. `ic_enabled` and `ic_min_delay_ms` are both on the
  application object, so this one the panel *can* do.

### Things in the fleet worth not tripping over

- **`NimbleGER-1` has an application whose name begins with a tab**:
  `\tblast_feed_cs`. Application names go into playback paths, so trimming it
  silently produces a link to an application that does not exist. Show it as
  it is.
- **`my-test-media2`** on Сердце Пальмиры has an empty `protocols` list — it
  emits nothing at all.
- **`NimbleRU-6`** carries no applications, though it is mapped and answering.
- **`fissure_mlbb` differs between edges**: HLS+RTMP on RU-2, HLS+**RTSP** on
  RU-3. A channel spread over both is not the same thing on each, and the panel
  should show the difference rather than average it.
- **`my_test` on RU-3 carries WHEP**, on a delivery edge — WebRTC does not
  cache and breaks the pull topology this fleet is built on.
- **`testZaderj` on mediaserver has a 100 s chunk.** Deliberate, by the name.
  Nothing should be derived from it.

---

## LL-HLS is reachable by an operator

`/llhls`. One row per edge, four marks that are never rolled into one, and a
third state on each: `?` is "nobody asked", which is fixed by opening the row,
not by buying a certificate.

The row opens into domain, TLS port, one of three certificate methods with its
cost written next to it, a masked nimble.conf diff behind "details", apply with
a per-step result, and rollback from the backups that run reported. The apply
carries the digest of the file the preview was computed from and is refused if
it moved.

What the screen deliberately does not do is claim LL-HLS works because the
configuration applied. Transport up and no parts in the playlist reads as not
working, with the two causes named.

## Ports 80 and 443 on an edge are free — that claim was wrong

`HANDOVER.md` said certificates on edges were awkward because "ports 80 and 443
are held by Nimble there, unlike the gateway", and this project repeated it for
weeks without checking. **It is not true.**

Nimble listens on 8081 for HTTP, 1935 for RTMP and 8082 for management; the
whole fleet was read over `http://…:8081` on 2026-08-17 and every playback probe
in this project uses that port. Nothing puts Nimble on 80 or 443.

Where the claim came from is visible in the sentence next to it: the agent
**reports which processes hold ports 80 and 443** as a readiness check, because
something might. A check for a possibility became a statement of fact
somewhere between the report and the handover note, and it was carried forward
because it sounded plausible and nobody grepped.

Same shape as the WMSPanel live-applications family: a written conclusion, not
checked against the source, repeated until it looked settled.

## What actually blocks a certificate on an edge

Not ports. **The privileged helper is only installed where the purpose is
`gateway`**, and on every other purpose the block is absent from the install
script rather than disabled — deliberately, because a block that exists and is
switched off is one somebody switches on by accident.

So today an edge has an agent that can read, and nothing that can write `/etc`
or install a package. Three things have to change before any of the certificate
methods below can run on one:

1. The helper has to be installable on edges. That widens what a compromised
   panel buys, and the current wording — "full control of the panel then buys
   nginx and certbot" — stops being true.
2. `/etc/nimble` has to join `ALLOWED_PATHS`, or the LL-HLS half cannot be
   written at all. `systemctl` is already allowed, so restarting Nimble needs
   nothing new.
3. Whether the helper on an edge should be allowed `nginx` at all. It is not
   needed there — Nimble serves the playlists itself — and leaving it out makes
   the edge helper strictly smaller than the gateway one.

This is a security decision, not a detail, and it is the operator's to make.

## Three ways to get a certificate, and why there are three

`backend/src/services/certPlan.js`.

| method | needs | renews itself | wildcard |
|---|---|---|---|
| `acme-http` | port 80 reachable, an A record | yes | no |
| `acme-dns` | a DNS provider API token | yes | yes |
| `upload` | a certificate and key you already have | **no** | whatever was issued |

`acme-http` is what the gateway plan already runs, so it is proven code rather
than a new idea. `acme-dns` needs nothing inbound, which matters wherever port
80 is filtered, and is the only one that can issue a wildcard.

**`upload` exists because the other two depend on a foreign service that has
started drawing lines.** On 4 June 2026 Let's Encrypt published Subscriber
Agreement 1.7 with a term about US sanctions; the reporting since is consistent
that issuance continues for private Russian companies and stops for state
institutions in fully sanctioned territories. ZeroSSL is reported to have
restricted `.ru` around the same time, and Buypass closed its free service in
August 2025.

For a commercial broadcaster ACME works today. "Works today" is the kind of
statement with an expiry date, and an edge whose certificate cannot be renewed
stops serving LL-HLS.

**The Ministry of Digital Development's free certificates go through `upload`,
and come with a warning that matters here specifically.** Their root is not in
Apple's or Chrome's trust stores — only in Yandex Browser, and elsewhere only
after a manual install. LL-HLS players are overwhelmingly Apple's. A
certificate the player refuses produces exactly the failure this feature exists
to avoid: playback that is silently not what it claims to be.

**What the panel checks before installing anything**: that the certificate
parses, that the key belongs to it, that the name is covered — from the SAN,
not the subject CN — that it is neither expired nor future-dated, that it is
not self-signed, and whether an intermediate is bundled. That last one is a
note rather than a refusal because a missing intermediate fails on some clients
and not others, which is worse than failing on all of them.

**None of that proves a player will accept it.** Trust is a property of the
client's store, and the only honest test is the handshake `tlsProbe.js` already
makes. The inspection result says `trustUnknown: true` so that passing cannot
be read as approval.

---

## Nimble's TLS port does not have to be 443

Softvelum's own LL-HLS article uses `https://localhost:8443/...` in its worked
example, and the parameter reference shows `ssl_port = 8077, 8087` — several
ports at once. `ssl_port` is free.

The 443 seen in `nimble.conf` is Nimble's **outbound** connection to
`api.wmspanel.com`. An outbound connection binds no local port: listening on
443 and dialling somebody else's 443 are unrelated.

So a reverse proxy in front of Nimble for LL-HLS is not needed, and adding one
would be worse than not: Nimble terminates TLS and speaks HTTP/2 itself, and a
proxy in between would have to be configured to pass HTTP/2 through without
downgrading it — which is precisely the failure LL-HLS shows as a silent
fallback to ordinary HLS.

An edge therefore needs a certificate, a free TLS port, and
`ssl_http2_enabled = true`. Nothing else about the machine has to change.
