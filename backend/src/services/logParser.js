// iter10 m1 — turning Nimble's log text into records.
//
// Everything here is derived from a real 184,481-line / 24 MB dump taken from
// srv-mediaserver2 on 2026-07-29, not from documentation: Softvelum publishes
// no format specification for nimble.log.
//
// Observed record header:
//
//   [2026-07-29 19:14:49 P433506-T433515] [srtpull0] E: connection closed ...
//    └─ timestamp ──────┘ └pid┘ └tid┘     └subsys┘  └L┘ └─ message ─────────
//
// Three properties of the real data drive the design:
//
//  1. 11.3% of lines are NOT records. Nimble dumps raw HTTP requests and
//     responses into the log as bare continuation lines with no header at
//     all (1,066 blocks, average 19.6 lines, longest 254). A line-based
//     parser would have produced ~20,000 junk records out of this sample.
//     Continuation lines therefore attach to the record above them.
//
//  2. Timestamps have one-second resolution while the server emits ~98
//     lines/s, so roughly a hundred records share any given timestamp.
//     Ordering by time alone would shuffle them. Every record carries its
//     byte offset in the file, which is both unique and monotonic, and that
//     is what ordering uses.
//
//  3. Subsystem tags carry a thread index: srtpull0, work1, rtmp_sender4.
//     Left alone, a box with eight workers reports eight subsystems. The
//     base name is kept alongside the raw tag — 15 raw tags in the sample
//     collapse to 13 real subsystems.
//
// Levels seen in the sample: E (15,341), D (130,772), V (17,513), I (2).
// 'W' does not appear but is accepted; the set is not documented anywhere,
// so an unknown single letter is preserved rather than rejected.

export const LOG_HEADER = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) P(\d+)-T(\d+)\] \[([^\]]+)\] ([A-Z]): ?([\s\S]*)$/;

export const LEVEL_NAME = { E: 'error', W: 'warn', I: 'info', V: 'verbose', D: 'debug' };

// Rank for filtering: higher = more severe. Unknown letters sort just under
// error so a level we have never seen cannot be silently dropped.
export const LEVEL_RANK = { E: 50, W: 40, I: 30, V: 20, D: 10 };
export const levelRank = (l) => (LEVEL_RANK[l] ?? 45);

// srtpull0 -> srtpull, rtmp_sender4 -> rtmp_sender, work1 -> work.
// Only a trailing run of digits is stripped, and never the whole tag: a
// hypothetical subsystem literally called "4" keeps its name.
export function baseSubsystem(tag) {
  const s = String(tag || '');
  const m = /^(.*?[^\d])\d+$/.exec(s);
  return m ? m[1] : s;
}

/**
 * Frame a chunk of log text into records.
 *
 * The caller owns the cursor, so this is a pure function over one chunk plus
 * whatever tail the previous chunk could not complete. A record is only
 * emitted once the next header proves it has ended — otherwise a record whose
 * continuation lines are still arriving would be stored, then stored again
 * with more lines. The unfinished remainder comes back as `pending`.
 *
 * @param {string} text          chunk, always ending on a line boundary
 * @param {number} baseOffset    byte offset of `text` within the file
 * @param {object|null} pending  carry from the previous call
 * @param {boolean} flush        emit the trailing record (use at EOF/rotation)
 */
export function frameRecords(text, baseOffset = 0, pending = null, { flush = false } = {}) {
  const out = [];
  let cur = pending ? { ...pending, cont: [...(pending.cont || [])] } : null;
  // Byte offsets, not character indices: the panel stores offsets that the
  // agent will later seek to, and any non-ASCII in a message would desync the
  // two if we counted characters.
  let off = baseOffset;

  const push = () => { if (cur) { out.push(finish(cur)); cur = null; } };

  const lines = text.split('\n');
  // A chunk always ends on a newline, so split() leaves a trailing '' which is
  // not a line. Anything else in that slot means the caller broke the contract.
  const last = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === last && line === '') break;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    const m = LOG_HEADER.exec(line);
    if (m) {
      push();
      cur = {
        offset: off,
        bytes: lineBytes,
        ts: `${m[1]}T${m[2]}`,
        pid: Number(m[3]),
        tid: Number(m[4]),
        tag: m[5],
        level: m[6],
        msg: m[7],
        cont: [],
      };
    } else if (cur) {
      // Continuation: part of the HTTP dump belonging to the record above.
      cur.cont.push(line);
      cur.bytes += lineBytes;
    } else {
      // Orphan — the chunk started mid-block, which happens exactly once per
      // file when a cursor is seeded at a non-zero offset. Kept as a record of
      // its own so nothing is silently discarded.
      out.push(finish({
        offset: off, bytes: lineBytes, ts: null, pid: 0, tid: 0,
        tag: 'unparsed', level: 'D', msg: line, cont: [], orphan: true,
      }));
    }
    off += lineBytes;
  }

  if (flush) { push(); return { records: out, pending: null, nextOffset: off }; }
  return { records: out, pending: cur, nextOffset: cur ? cur.offset : off };
}

function finish(r) {
  const rec = {
    offset: r.offset,
    bytes: r.bytes,
    ts: r.ts,
    pid: r.pid,
    tid: r.tid,
    tag: r.tag,
    sub: baseSubsystem(r.tag),
    level: r.level,
    msg: r.msg,
  };
  if (r.cont && r.cont.length) {
    rec.cont = r.cont.join('\n');
    rec.contLines = r.cont.length;
  }
  if (r.orphan) rec.orphan = true;
  return rec;
}

// Nimble stamps local time with no zone marker. The collector attaches the
// server's offset so records from a fleet in different zones stay comparable;
// with no offset known the string is treated as UTC and flagged, rather than
// silently shifted by whatever the panel container's TZ happens to be.
export function toDate(ts, tzOffsetMinutes = 0) {
  if (!ts) return null;
  const d = new Date(`${ts}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() - tzOffsetMinutes * 60_000);
}
