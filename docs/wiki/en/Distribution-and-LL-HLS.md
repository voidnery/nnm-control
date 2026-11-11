# Distribution and LL-HLS

English · [Русский](../ru/Distribution-and-LL-HLS.md)

## Distribution

**Broadcast → Distribution** — delivery networks: who takes the stream from whom, what is delivered and
which links to watch. The menu entry shows with `wmsobjects.view` in WMSPanel mode; working with
networks needs `cdn.view` (viewing) and `cdn.manage` (changing) — you need both.

Sections: **Channels** (opens first), **Delivery network**, **Geography**.

### Network and node roles

**New network** → **Add a server…** → role and **Takes content from**:

| Role | May take from |
|---|---|
| Ingest | nowhere |
| Origin | ingest |
| Mid-tier | origin |
| Edge | origin or mid-tier |
| Gateway | nowhere — sends viewers to edges |

Saving is refused for a wrong role, a repeated server, a node taking from itself, a source it may not
take from, or a cycle; a node with no source is saved with a warning. Deleting a network leaves the
servers alone.

### Setting up the servers

The **Setup** tab has three steps: **1 · What we deliver**, **2 · Setup on the servers**, **3 · Does it
arrive**.

1. **Applications this network carries** — a Nimble route is set per application, so every stream of the
   application is delivered.
2. **Show plan** — which routes will be created on each edge (`/app/` → `origin:port/app/`). **Apply**
   creates and updates routes in WMSPanel, reads each back; on failure it rolls back only the routes
   created in that run.
3. **Apply never deletes routes.** An application switched off keeps being delivered until its route is
   deleted by hand (**Already written to WMSPanel**).

The plan will not apply if the application on the edge is in HTTP Origin mode (the edge does not cache),
or the edge has no WMSPanel mapping or no source. It needs a check when the origin's HTTP port is not set
(8081 is assumed) or a node has several sources (the first is used).

### Does it arrive

- **Check state** — reads live streams from every node (through the agent or directly, without spending
  WMSPanel): flowing, at rest (route exists, no viewers — that is normal), no route, nothing published
  yet, the node did not answer.
- **Watch now** — asks every node for the playlist as a player would, and again a few seconds later to see
  whether it moves: "yes, and moving", "serves a frozen playlist", "no route (404)", "refused (403)",
  "origin failed (5xx)", "timed out", "unreachable".

### Monitoring channels

**Check on our own, every N min** (off by default; 5 … 1440 min, `cdn.manage`). Enabled channels of
networks with monitoring are checked on every edge, as a viewer; an edge with a recent agent is also asked
from inside, to tell "not serving" from "not reachable".

A channel is **healthy** when at least one edge was checked and every checked edge answered normally. If
the panel itself could not check, nothing is recorded and it does not count as an outage. On a change —
the `channel.unhealthy` / `channel.healthy` events; a first check that is bad also gives an event.

History: availability over an hour, a day, a week, the last 24 checks per channel, the slowest answer.

### Channels and links

**Add channel** — application and stream (cannot be changed later), production or test, what the viewer
gets: HLS, LL-HLS (the link appears once TLS and HTTP/2 are confirmed on the edge), DASH. Streams already
on the origin that are not channels yet are listed — a click fills in a new channel.

- **Production link** — through the gateway; shows which edge it leads to right now.
- **Test links** — straight at each edge.

**Who may watch**: anyone; a signed link (20 min by default, can be tied to the viewer's IP); our sites
only; by country; by IP range. Protection takes effect after **Write the protection** on the network.
**Replace the key** — every link already issued stops working.

**Replay from the archive** — links into the recording (recording itself is switched on in WMSPanel).

### Gateway

Modes: **Straight to the edge** (default), **Redirect gateway** (answers 302), **Proxy gateway**. A
gateway needs the agent and the helper. Picking an edge: **Nearest** (needs coordinates and the geo
database), **Least loaded**, **By weight**, **In order**. **When no edge is healthy**: refuse (default)
or send to the origin. **Work it out** shows the decision without sending anyone anywhere.

Saving the network rewrites the gateway's nginx by itself; if that fails, the panel says why (no helper,
gateway not prepared, an edge has no address).

### Geography

The offline DB-IP database: **Download / update** (the Country edition has no coordinates, City has them
and is ~15 times larger). **Resolve** / **Resolve all** — node coordinates; values entered by hand are
never overwritten.

## LL-HLS

**Broadcast → LL-HLS** — turning on Low-Latency HLS on edges. Viewing — `servers.view`; plan, write,
rollback, the per-application switch — `servers.manage`.

LL-HLS works only when all four hold:

1. the machine has the privileged helper;
2. there is a certificate and it has time left;
3. TLS answers with HTTP/2 (ALPN h2) and a certificate a player accepts;
4. the playlist carries parts.

If only the parts are missing, the player silently gets ordinary HLS and nobody learns about it. That is
why the panel checks this too.

### Certificate

Judged by what the server actually presents in the TLS handshake, not by files:

| State | What to do |
|---|---|
| Certificate works | nothing |
| Expiring soon (20 days or less) | reissue |
| Expired | reissue |
| A player will refuse it (no intermediate, self-signed) | reissue |
| Does not cover the name | change the domain — reissuing gives the same |
| Configured, but nothing answered on the TLS port | check Nimble and the port |
| Not configured | issue |

Expiring certificates of names viewers reach over HTTPS are also reported as the `certificate.expiring`
event — see [Events and reactions](Events-and-reactions.md).

### Transport

1. Domain (DNS must already point at the machine), **TLS port** (8443 by default).
2. Method:
   - Let's Encrypt over port 80 — renews itself; port 80 must be reachable from the internet;
   - Let's Encrypt over a DNS record — renews itself; needs a DNS provider API token; the only way to get
     a wildcard;
   - **A certificate you already have** — paste the chain and the key; nothing renews it. Russian
     Ministry of Digital Development certificates go here (Apple and Chrome do not trust them).
3. **Show what would be written** — the diff of `nimble.conf`, secrets hidden.
4. **Write it and restart Nimble** — a background job of up to 15 minutes with a log. Restarting Nimble
   drops viewer sessions. It is done only when the TLS check afterwards confirmed HTTP/2. If `nimble.conf`
   changed after the preview — refused.
5. **Put it back** — from the backups.

### Applications

**Turn on** LL-HLS on an edge application: the part size is at least 500 ms and at most half a chunk
(values outside the range are refused, not adjusted). It needs the HLS container; "also switch the
container to fMP4" **removes plain HLS**. After turning it on **the input stream must be restarted**,
otherwise nothing changes for viewers. **Ask the wire** — check the parts on a given stream.
