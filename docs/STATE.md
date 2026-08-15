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
  written yet. TLS on an edge is what it waits for.
- **Agent fleet** — several edges have no agent, so they are read by direct
  dial and cannot be measured *from*.

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

**An address comes from the operator.** The Host field on a server outranks
anything synced from WMSPanel: WMSPanel'"'"'s domains are a fact about WMSPanel,
and the Host field is a person saying where the machine is. Where a machine has
several addresses, all of them are offered rather than one being chosen — the
panel cannot know which name resolves correctly today.

**Anything read from a machine is stamped.** A fact about TLS or delivery from
last week is not a fact about now, and a green mark that stopped being true is
worse than an empty one.
