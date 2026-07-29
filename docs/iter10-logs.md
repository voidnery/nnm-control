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
