# NNM Control — starting a new session

Attach the project archive (`nnm-control-v1.27.0.tar.gz` or later) and this
file. Everything else is in the archive.

## Read these first, in this order

| file | why |
|---|---|
| `docs/FAILURES.md` | the mistakes this project makes repeatedly — short, and the most expensive thing here |
| `docs/STATE.md` | what is true about the fleet and the panel, with dates |
| `docs/wmspanel-api.md` | what the WMSPanel API allows — **read it, do not recall it** |
| `docs/wmspanel-api-application.md` | the published reference for live applications, copied by hand |
| `docs/recon-scripts.md` | rules for any script run on somebody else's machine |
| `CHANGELOG.md` | the last twenty entries carry the reasoning behind recent code |

## The order of work

**Analysis, then research, then code. Code is always last.**

Agreed 2026-08-21, after a branch in which every expensive mistake came from
inverting it.

1. **Analysis.** What is being asked, what would count as an answer, what is
   already known — from `docs/`, from the code, from a `grep`. Most of this
   branch's failures were answerable here and were not asked here; twice a
   question was settled by re-reading a dump already in hand.
2. **Research.** A script, a probe, a measurement against the real thing.
   Read-only where possible, guarded where not, proven by contradiction before
   it is trusted.
3. **Code.** Written to what was measured. Never as a way of finding out.

## Where LL-HLS stands

**Working, measured on the wire.** `nnm-probe/feed1` on NimbleRU-6, 2026-08-22,
fMP4: the server held a request for the part it had itself hinted at for
1.59 s against a `PART-TARGET` of 2.002 s. That is blocking reload — the
mechanism, not the decoration. Parts in a playlist prove nothing alone.

The chain works end to end: privileged helper on a media server → certificate
by name → `ssl_port` and `ssl_http2_enabled` in `nimble.conf` →
`alhls_enabled` and `hls_part_duration` in WMSPanel → input stream restarted →
parts.

**What limits latency now is not the panel.** `PART-HOLD-BACK` is 6.006 s
because the part is 2000 ms. The floor is 500 ms — measured; the published
reference's 250 is wrong — and shorter parts cost bandwidth.

### Open, in the order they were left

1. **The MPEG-TS run.** Does blocking reload work on plain `HLS` as it does on
   fMP4. Two earlier attempts are **withdrawn**, both mistargeted — see
   `STATE.md`. Set the container back to plain `HLS` (**not** `HLS (MPEGTS)`,
   which is a third, never-measured value), restart the input, run
   `llhls-check --chunk=6`.
2. **Keyframe interval on `feed1` reads as 4.004 s**, from `INDEPENDENT=YES`
   spacing in one dump. A 6 s chunk cannot be cut evenly at 4.004, hence
   segments of 4.004 and 8.008. **Derived from a short window** — run
   `llhls-check --chunk=6` two or three times and see whether it reports
   `steady`. The fix is a 2 s keyframe interval on the encoder or a 4 s chunk
   in the panel; the tool names both with the side they belong to.
3. **`ic_enabled` is never surfaced.** Softvelum recommends interleaving
   compensation with zero minimum delay for video+audio at low latency;
   `llhls.js` has carried it as `INTERLEAVING_FIX` since v1.11.3 and no screen
   shows it. It is off on `nnm-probe` and nobody would know.
4. **Rollout.** One edge of fourteen. `selectel(24/7)` is still labelled
   `nimble` while it serves viewers, so it does not appear on `/llhls` at all —
   the purpose filter working correctly on wrong data.
5. **Certificate renewal is unwatched.** The panel counts days and warns at 20;
   nothing checks on a schedule.
6. **`docker manifest inspect` in `apt-repo`** before building the `.deb`, so a
   partial image set cannot become a package.
7. **WMSPanel writes to several servers at once.** Its application form has a
   server list at the bottom; the panel writes one edge at a time. Worth
   understanding before rollout.

## Tools, and what each answers

| tool | question |
|---|---|
| `backend/tools/llhls-check.mjs` | is this really LL-HLS, from a viewer's side |
| `backend/tools/wms-playback-probe.mjs` | what does the edge serve, and does a change move it |
| `backend/tools/wms-apps-recon.mjs` | what do the fleet's live applications look like |
| `backend/tools/wms-app-write-probe.mjs` | what does WMSPanel do on a write (guarded to `nnm-probe`) |
| `backend/tools/wms-app-write-probe-profile.mjs` | what does WMSPanel accept and **store** for an application's output profile — protocols, container, chunk, part, interleaving compensation. Read-only without `--write`, guarded to `nnm-probe`, restores from its own baseline. **Written and not yet run.** |
| `backend/tools/wms-dump.mjs` | which API routes exist |

All standalone, no dependencies, reports written beside themselves. Read
`docs/recon-scripts.md` before writing another.

## How this project works

- **Every milestone**: a cumulative archive, key files inline, gates proven by
  contradiction, and explicit approval before proceeding.
- **Run the diversion. Always.** When it changes nothing, suspect the diversion
  before believing the check: in one session three were empty — one was a
  syntax error, one did not match the string it meant to patch, and three
  checks sat after `process.exit` and never ran at all.
- **A diversion that changes no test means the tests miss the wiring**, not
  that the code is safe. Happened twice; both times a check was added.
- **A check that fires on correct code gets narrowed, not switched off.** Seven
  times, and five were the same shape: a pattern matched against a *comment*
  explaining the very rule. Strip comments before matching.
- Code and comments in English; conversation in Russian.

## Never do these

- **`docker compose` by hand on production.** The unit passes
  `--env-file /etc/nnm-control/nnm-control.env`; without it compose pulls
  `latest`, starts a stack with blank secrets and takes the published port.
  `systemctl restart nnm-control` is the way. Doing this during an incident
  lengthened it.
- **Conclude absence from a probe that asked something else.**
- **Change two things at once and then reason about the result.** The container
  question was unanswerable for a day because of it.
