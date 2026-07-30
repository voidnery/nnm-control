# iter10 — Nimble logs: what the dump proved

Everything below is measured from a real 184,481-line / 23.96 MB sample taken
from `srv-mediaserver2` on 2026-07-29 between 19:14:49 and 19:46:06. Softvelum
publishes no format specification for `nimble.log`, so this file, not the
documentation, is the contract.

## Record shape

```
[2026-07-29 19:14:49 P433506-T433515] [srtpull0] E: connection closed for [...]
 └─ date ──┘ └─ time ┘ └pid─┘ └tid──┘  └subsys─┘ └L┘ └─ message ──────────────
```

Levels present: `E` 15,341 · `D` 130,772 · `V` 17,513 · `I` 2. No `W` appears,
but the set is undocumented so an unknown letter is preserved and ranked just
below error rather than discarded.

## Three findings that shaped the design

### 1. 11.3% of lines are not records

Nimble dumps raw HTTP requests and responses into the log as bare continuation
lines with no timestamp:

```
[2026-07-29 19:14:54 ...] [work1] D: cli s=217 req (96B):
GET /ses/atp_feed1/playlist.m3u8 HTTP/1.1
Host: 192.168.200.15:8081
Connection: keep-alive
```

1,066 such blocks, average 19.6 lines, longest 254 — 20,853 lines in total. A
line-per-record parser would have produced twenty thousand junk entries out of
this one sample. Continuation lines therefore attach to the record above, and a
record is not emitted until the next header proves it has ended.

### 2. Timestamps cannot order anything

The stamp has one-second resolution and the server emits **98.3 lines/s**, so
roughly a hundred records share every stamp. Ordering is by byte offset within
a file generation, which is unique and monotonic. This is why every record
stores its offset and why `gen` exists.

### 3. The fleet moves 14 GB/day

12,765 B/s → **1.10 GB/day per server → 14.3 GB/day across 13**.

The obvious economy — drop `D` — does not work. Level mix by subsystem:

| subsystem | records | non-debug |
|---|---:|---:|
| srtpull | 101,815 | 15.0% |
| util | 14,862 | 93.8% |
| srtlisten | 11,455 | 0.0% |
| work | 9,849 | 23.8% |
| **remtranmgmt** (transcoder) | 9,447 | **0.02%** |
| m2ts_srt_sender | 6,315 | 0.0% |
| livepull | 5,733 | 12.7% |
| rtmp | 772 | 0.0% |

The transcoder, the SRT listener and RTMP emit essentially **nothing but
debug**. Dropping `D` would empty exactly the categories this epic exists to
show. Retention has to be time-tiered, not level-filtered — that is m2's
problem, and m1 bounds the risk with a capped collection instead.

## Decisions taken (the open questions from the plan)

**Transport: agent tailing files.** Nimble can emit to syslog, but the sink is
a `nimble.conf` parameter and Softvelum's reference is explicit that config
changes require the instance to be **re-started**. That is 13 restarts of live
broadcast servers plus an rsyslog rollout, versus an agent that has to be
installed on those boxes anyway. Nimble is not touched at all.

**Access log: not enabled.** `grep -i log /etc/nimble/nimble.conf` returns only
`logging = info`, so `log_access` is off and no `access.log` exists. At HLS
scale it is one line per segment per viewer and would dwarf everything measured
above. Out of scope until there is a reason.

**Effective level is debug, not what the config says.** The config file says
`logging = info`, yet 80% of the sample is `D`. The level is being set
elsewhere — WMSPanel's per-server UI applies it without a restart and overrides
the file. Worth knowing before anyone concludes the config is authoritative.

## Rotation

Nimble rotates by size (`max_log_file_size`, 128 MB default;
`max_log_files_to_keep`). A rotation is detected as *same name, different
inode*; in-place truncation is detected as *size below the cursor*. Rotated
copies (`nimble.log.1`) are deliberately **not** served — their extension is
not a log extension — so the panel follows the live file and records the gap in
`bytesMissed` rather than presenting a tail that silently has a hole in it.

## An operational finding, free of charge

99.3% of all errors in the sample are one repeated line:

```
srtpull0 E: connection closed for [<ip>:<port>] socket=N errno=2002
           srterror=[Connection does not exist]
```

15,237 occurrences in 31 minutes — 8.1/s — of which 12,019 come from just two
internal peers, `192.168.200.23` and `192.168.200.24`, at about 3.2/s each.
Whatever that is, it is either a real fault worth fixing or a permanent noise
floor. Either way the "errors" view must collapse repeats by template, or it
will be fifteen thousand identical rows during the exact incident someone needs
it for. That requirement came out of the data, not out of a wireframe.


## m3 — how the warehouse is read (v0.14.0)

The finding from m1 — that 99.3% of errors are one repeated line — turned out
to define the whole view, not just a caveat about it.

**Templating, chosen by measurement.** Two strategies were run over the real
file:

| strategy | templates | error templates |
|---|---:|---:|
| collapse every `[...]` span | 140 | 2 |
| collapse `[...]` only when it contains a digit | 142 | **4** |

The second wins for a reason that only shows up in the data: the first merges
`srterror=[Connection does not exist]`, `[Operation not supported: Invalid
socket ID]` and `[Connection was broken]` into one row. Three different faults,
one line. Addresses and socket ids in brackets are noise; a sentence in
brackets is the diagnosis.

Result on the real file: **163,628 records → 142 templates**, a 1,150×
reduction with nothing diagnostic lost.

**What is not done here.** Free text is a regex scan over `msg` and `cont`,
bounded by whatever the indexed filters already narrowed. A text index cannot
answer "contains this substring", which is what an operator chasing a stream
name actually types, so the trade is deliberate — but it does mean a wide time
range with a text query is the slow path, and the scan cap exists to stop it
being an unbounded one.


## m4 — the functional windows (v0.14.1)

Which subsystem belongs to which window, checked against the real dump before
being written into code:

| window | subsystems | records | % | errors |
|---|---|---:|---:|---:|
| SRT | srtpull, srtlisten, m2ts_srt_sender, m2ts_srt_srv | 121,018 | 74.0 | 15,237 |
| core | util, sync, list | 16,261 | 9.9 | 0 |
| playback / HTTP | work | 9,849 | 6.0 | 0 |
| transcoder | remtranmgmt | 9,447 | 5.8 | 0 |
| pull ingest | livepull | 5,733 | 3.5 | 104 |
| RTMP | rtmp, rtmp_sender | 1,209 | 0.7 | 0 |
| DVR | dvrmain | 111 | 0.1 | 0 |
| other | — everything else — | 0 | 0.0 | 0 |

Coverage: **100.00%**, nothing uncategorised.

Two things follow from the numbers rather than from taste. Every error in this
window lives in two categories, so the overview strip showing per-window error
counts answers "which part is unhappy" before anything is read. And `other`
holds nothing here but must exist and must be defined by **exclusion**: this
sample has no WebRTC, no DVR variants and one transcoder mode, so an `$in`
list could never match a subsystem the mapping has not met.

`LogWindow` was built self-contained — it owns its filters, its polling and its
state, and takes only a scope and a size — because m5 is "place any number of
these where you choose", and that should not require the component to learn
anything about dashboards.


## m5 — dashboards and links (v0.15.0)

The link is the part that needed care. It is read access to production logs
without a password, on data that contains publish URLs with stream keys in
them.

**What the token grants is bounded by construction.** The public route looks up
the dashboard by the token's hash, finds the requested window *in the
database*, and builds the query from that window's stored fields. The query
string is not consulted at all — there is a test asserting no `req.query`
appears anywhere in the public half of the router. So a link to a transcoder
window is a link to that window, and cannot be turned into a query for the
warehouse by editing the URL.

**What it still exposes, stated rather than hidden.** Stream keys are masked,
including in raw rows, which are *not* masked inside the panel because an
operator needs the exact line. IP addresses, stream names and error text are
not masked, and the warning next to the button says so.

**Issuing is its own permission and its own act.** `logs.manage` is separate
from `streams.view`: being allowed to read logs in the panel and being allowed
to make them readable without a password are different decisions. Issuing is
audited, sharing is off by default, the token is stored only as a hash, and
revocation takes effect even for someone holding the old URL because
`shareEnabled` is checked as well.
