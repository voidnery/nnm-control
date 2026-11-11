# Servers and agents

English · [Русский](../ru/Servers-and-agents.md)

## Servers

**Broadcast → Servers.** Viewing needs `servers.view`; adding, editing, deleting and reordering need
`servers.manage`.

### Where they come from

In WMSPanel mode the panel takes Nimble servers from WMSPanel on its own: 15 seconds after start and then
every 10 minutes (the **Sync now** button — right away). Servers are matched by their WMSPanel id.

- Name, tags, status and domains are refreshed on every sync.
- **Host** is filled only when it is empty — an address you corrected is never overwritten.
- A new server gets management port 8082 and an empty token — set the token from `nimble.conf`,
  otherwise there is no live state and no statistics.
- A server that disappears from WMSPanel is **not deleted** from the panel.

### Add or edit

**+ Add server**:

- **What this machine is for** — first, because the other fields depend on it:
  - **A Nimble media server**;
  - **A media server and a node in a delivery network** — for [distribution](Distribution-and-LL-HLS.md);
  - **Edge-proxy — delivery without Nimble** — a gateway; it has no WMSPanel mapping and no Nimble ports.
- **Name**, **Host (IP or DNS)** — the address the panel reaches Nimble's own API on.
- **Management port and token** — from `nimble.conf` (port 8082 by default). When editing, an empty
  token field keeps the current one.
- **WMSPanel server** — the mapping. Without it, stream settings, functions and categories are not
  available for the server.
- **Tags** — comma-separated.
- **Playback endpoints** — the addresses viewers watch from: label, host, HLS port (8081), RTMP port
  (1935), SSL. Needed for the Watch button, links and certificate checks.
- **HTTP port** of Nimble (8081 by default) — no API reports it, so the operator sets it.
- **HTTPS port** — empty = 443; needed for LL-HLS. **Check TLS** — after saving.

Deleting a server removes it **from the panel only**; nothing changes on the server itself or in
WMSPanel.

### The server page

Which tabs you see depends on the control mode.

**WMSPanel mode** (viewing — `wmsobjects.view`, changing — `wmsobjects.manage`; the server must be
mapped to WMSPanel):

| Tab | What it is |
|---|---|
| Streams | live streams |
| Apps, Interfaces | live applications and RTMP interfaces |
| RTMP Pull | pulling streams (live pull), with fallback URLs; restart |
| RTMP Push | republish — sending a stream on (`republish.view` / `republish.manage`) |
| SRT In | MPEG-TS/SRT inputs |
| SRT Out | UDP/SRT outputs |
| SRT in Nimble | outgoing MPEG-TS: pause, resume, restart |
| Hotswap | hot swap of the source |
| Charts | charts (`streams.view`) |

Changes are written to WMSPanel and reach Nimble on its sync cycle — about 30 seconds.

**Backup Native Nimble API mode**: Streams (every 10 s), Sessions (every 15 s; **Disconnect selected** —
`sessions.manage`), SRT (read-only), MPEG-TS, Playout, Control (**Reload config**, **Reload SSL**,
**Sync WMSPanel** — `control.manage`). Changes in this mode are temporary: they are lost on a
configuration reload and are seen only on that server.

### Charts

The **Charts** tab — history from 15 min to 72 h, **Everything** or **One stream**, **Live**. **Collect
metrics** must be on in Settings (every 10 s by default, kept 3 days). Ever-growing counters are drawn as
per-second rates.

**Why is data missing?** explains each source: "empty" — the server really has nothing of that kind; a
red line — the panel could not ask (check the management address and token).

## The agent on the server

The agent is a small service on the server that works with its files: writes playlists and configs,
accepts media files, sends Nimble logs. It is **optional**: everything else works without it.

The agent calls the panel itself (it waits for work about every 25 seconds); the panel never connects to
it, so it works behind NAT. The agent does not touch Nimble.

Rights: viewing — `servers.view`; installing, updating, removing — `servers.manage`.

### Install with a command

1. **Infrastructure → Agents** → on the server, **Install agent**.
2. **I run a command**.
3. **Address the SERVER will use to reach this panel** — prefilled from the browser; correct it if the
   servers cannot resolve that name or the certificate does not match it. (Permanently — **Public
   address of this panel** in Settings.)
4. The Nimble log directory (`/var/log/nimble` by default).
5. **Issue install command** and run it on the server as root. The **Verified** variant checks the
   script against a SHA-256 before running it — recommended.

Progress is shown on the page: ticket issued → server fetched the installer → agent enrolled.

- The ticket is single-use and valid for 30 minutes. A new ticket cancels the previous unused one.
- The installer needs root, `curl` and Node.js 18+. The agent token is created on the server itself.
- If the panel is opened over `http://`, the token travels in clear text — the installer warns.

### Install over SSH

**The panel installs over SSH** → **Read the host key**, compare the fingerprint → password or private key
(sudo possible) → **Install now**. The credentials are stored nowhere — not in the database, on disk or in
the audit log. If the host key changed, the install stops before the password is sent.

### The privileged helper

A separate root service for delivery machines and gateways: installs packages, issues certificates,
writes nginx/Nimble configs. It can run only six named programs (`apt-get`, `certbot`, `nginx`,
`systemctl`, `ln`, `rm`) and write only to its own directories. **Install helper** — once the agent is
configured; the script is shown and you run it.

### When the agent is silent

| Message | What it means | What to do |
|---|---|---|
| The agent has never called in | install not finished or the agent cannot reach the panel | `journalctl -u nnm-agent -n 50` |
| The agent has stopped polling | last contact more than 70 s ago | `systemctl status nnm-agent` |
| The agent is restarting in a loop | 3 or more restarts in 10 minutes | `journalctl -u nnm-agent -n 200` |
| The agent took the work and never answered | one operation hung; a large upload over a slow link looks the same | wait or check the link |
| The panel failed to hand the task over | a **panel** fault | report it to the developer: server and time |
| Agent is polling normally | all is well | — |

The watchdog checks agents every 30 seconds and records a change only when it repeats 3 times in a row
(~90 s) — flapping stays quiet. That is where the `agent.offline` and `agent.online` events come from.
**The watchdog itself restarts nothing.**

**Agent centre**: how many agents are in trouble and out of date; **Update all that are behind** (only
agents that are calling in get the update; the agent checks the digest); **Ping**; **Recover** — a
restart over SSH that collects the journal.

**Network interfaces to graph** — which interfaces the dashboard draws (nothing ticked — all physical).
