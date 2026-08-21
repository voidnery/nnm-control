# NNM Control — starting a new session

Attach the project archive (`nnm-control-v1.24.0.tar.gz` or later) and this
file. Everything else is in the archive.

## Read these first, in this order

| file | why |
|---|---|
| `docs/STATE.md` | what is true about the fleet and the panel, with dates |
| `docs/wmspanel-api.md` | what the WMSPanel API allows — **read it, do not recall it** |
| `docs/recon-scripts.md` | rules for any script run on somebody else's machine |
| `CHANGELOG.md` | the last fifteen entries carry the reasoning behind recent code |

## Where LL-HLS stands

**The transport half is done and proven on a live edge.** NimbleRU-6, 2026-08-21:
privileged helper installed, `nimble.conf` written, HTTP/2 negotiated, a
Let's Encrypt certificate for `cdn-test-edge-1.bbesport.com` with 87 days left
that a player accepts. The `/llhls` screen sweeps every edge on load, probes by
**name** rather than by address, finds a live stream through WMSPanel instead
of asking for one, and puts every fault in one Details window with the fix and
the machine's own words.

**Both halves now have a screen** (v1.25.0): applications on an edge, with the
checkbox, the part duration and its range, the container switch as its own
consent, and the restart notice on every enable. **It has never been run
against a live application.** `nnm-probe` on RU-6 is the first target — the
panel already says `alhls_enabled` is off there and everything else on that
edge is green.

Superseded, kept for the reasoning: The routes have
existed since v1.15.0 (`POST /api/llhls/channels/:id/plan` and `/apply`), and
`llhlsState.channelPlan` composes it with its warnings. What is missing is a
place for an operator to press it. `nnm-probe` on RU-6 is the obvious first
target: everything else about that edge is green and the panel already says
`alhls_enabled` is off there.

Two things that must survive into that screen, both measured:

- **`hls_part_duration` ≥ 500 ms and ≤ half the chunk.** The API reference says
  250; the server refuses it. At the fleet's 6-second chunk the vendor's
  recommendation is 2000 ms.
- **The input stream must be restarted** after enabling, or Nimble keeps
  producing the old output. The panel cannot do this for a published stream and
  must say so rather than report a write as a working feature.

## Then

- **Certificate renewal is unwatched.** The panel counts days and warns at 20;
  nothing checks on a schedule.
- **`docker manifest inspect` in `apt-repo`** before building the `.deb`, so a
  partial image set cannot become a package. Not what caused the 2026-08-19
  outage, but still possible.

## How this project works

- **Find out first, then fix.** Established as a rule and earned repeatedly.
- **Every milestone**: a cumulative archive, key files inline, and gates proven
  by contradiction.
- **Run the diversion. Always.** And when it changes nothing, suspect the
  diversion before believing the check: in one session three were empty — one
  was a syntax error, one did not match the string it meant to patch, and three
  checks sat after `process.exit` and never ran at all.
- **A check that fires on correct code gets narrowed, not switched off.** Six
  times now, and five of those were the same shape: a pattern matched against
  a *comment* explaining the very rule. Strip comments before matching.
- Code and comments in English; conversation in Russian.

## The failure that keeps coming back

**A value used against a shape it does not have.** Five instances, all silent:

- `agent` read from `/servers`, `gateway` from the networks list, `host` from a
  network node.
- `server.agent.privileged` — a field no schema has. Every machine read as
  "never reported"; installing a helper by hand changed nothing visible. The
  correct rule was already written one file away.
- `probeTls({ host, port })` on a function declared `probeTls(host, port)`. The
  whole object went into `options.host`, so **every HTTP/2 probe threw before
  opening a socket** — on every machine, for four versions, while the screen
  showed first `?` and then `✗`.

Every one of them was written from the shape of a neighbouring call rather than
from the thing being called. **Open the signature, not the call site next to
it.**

## Other failures worth carrying forward

- **Work measured in minutes inside a held-open HTTP request.** Four times. The
  gateway preparation had already solved it with a job store, one file away,
  and the LL-HLS apply did not use it — 504 from the proxy while the work
  carried on underneath.
- **Something succeeded and did nothing.** A `postinst` that printed two
  warnings and then "NNM Control installed" with a setup token, exit 0, while
  the panel was down. An install that leaves the panel down must fail.
- **Concluding absence from the wrong probe.** "The image is not published"
  from its absence on disk; the pull was killed mid-download by a start
  timeout. Ask the thing you mean to ask.
- **Never run `docker compose` by hand on production.** The unit passes
  `--env-file /etc/nnm-control/nnm-control.env`; without it compose pulls
  `latest`, starts a stack with blank secrets, and takes the published port.
  `systemctl restart nnm-control` is the way.
