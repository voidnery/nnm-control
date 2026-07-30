// iter12 m2 — receiving log batches the agent pushes.
//
// iter10 m1 had the panel pull byte ranges out of every agent on a timer: it
// held the cursor, guessed at rotation from what it could see between two
// polls, and had to reach all 13 servers, which a machine behind NAT rules
// out entirely. The tail lives on the agent now. What remains here is the
// half that was always panel-side and is worth keeping exactly as it was:
//
//   * FRAMING. 11.3% of Nimble's log lines are continuation text from HTTP
//     dumps with no header of their own, so records span lines. frameRecords
//     was verified byte-exact against a real 184,481-line file, and moving it
//     into a dependency-free agent would have meant reimplementing it there.
//     The agent ships raw bytes; the parser stays in one place.
//
//   * THE PENDING CARRY. A record whose continuation lines land in the next
//     batch must be stored once, whole. The agent splits on line boundaries;
//     this side stitches records back together across batches.
//
// The cursor in LogCursor is now a RECEIPT, not a position: the agent owns
// the position. What is recorded here is what arrived, what was missed, and
// when — the things an operator needs when a tail looks wrong.
import { NimbleServer } from '../models/NimbleServer.js';
import { LogRecord, LogCursor } from '../models/LogRecord.js';
import { frameRecords, toDate } from './logParser.js';

export const DEFAULT_FILES = ['nimble.log'];

const state = { lastIngestAt: null, batches: 0, records: 0, bytes: 0, lastError: '' };

export function collectorState() {
  return { ...state, mode: 'push' };
}

/**
 * Ingest one batch from one agent.
 *
 * Batches arrive in order per file, and each ends on a line boundary. A gap
 * between where we last were and where this batch starts means bytes were
 * lost — a rotation the agent could not drain in time, or a restart with an
 * unwritable state directory. That is recorded rather than smoothed over: a
 * tail with a silent hole in it is worse than one that admits the hole.
 */
export async function ingestBatch(server, { file, ino, gen, offset, data }) {
  const cursor = await LogCursor.findOneAndUpdate(
    { serverId: server._id, file },
    { $setOnInsert: { offset: 0, ino: '', gen: 0 } },
    { new: true, upsert: true },
  );

  let rotated = false;
  if (cursor.ino && ino && cursor.ino !== ino) {
    rotated = true;
    cursor.rotations += 1;
    cursor.gen += 1;
    cursor.pending = null;
  } else if (gen) {
    rotated = true;
    cursor.rotations += 1;
    cursor.gen += 1;
    cursor.pending = null;
  }
  cursor.ino = ino || cursor.ino;

  let missed = 0;
  if (!rotated && cursor.offset && offset > cursor.offset) {
    missed = offset - cursor.offset;
    cursor.bytesMissed += missed;
    cursor.pending = null;      // whatever was open is unfinishable now
  }
  // A replay of bytes we already have: the agent shipped, we stored, and the
  // acknowledgement never arrived. Dropping it is the only safe answer —
  // storing it twice would put duplicate records in front of the operator.
  if (!rotated && offset < cursor.offset) {
    return { stored: 0, duplicate: true, at: cursor.offset };
  }

  const framed = frameRecords(data, offset, cursor.pending || null, { flush: false });
  cursor.pending = framed.pending;

  if (framed.records.length) {
    const tz = Number(server.logTzOffsetMinutes || 0);
    await LogRecord.insertMany(framed.records.map(r => ({
      serverId: server._id,
      file,
      offset: r.offset,
      bytes: r.bytes,
      gen: cursor.gen,
      ts: toDate(r.ts, tz),
      raw: r.ts || '',
      pid: r.pid, tid: r.tid,
      tag: r.tag, sub: r.sub, level: r.level,
      msg: r.msg,
      cont: r.cont || '',
      contLines: r.contLines || 0,
      orphan: Boolean(r.orphan),
    })), { ordered: false });
  }

  cursor.offset = offset + Buffer.byteLength(data, 'utf8');
  cursor.bytesRead += Buffer.byteLength(data, 'utf8');
  cursor.recordsStored += framed.records.length;
  cursor.lastAt = new Date();
  cursor.lastError = '';
  await cursor.save();

  state.lastIngestAt = new Date();
  state.batches += 1;
  state.records += framed.records.length;
  state.bytes += Buffer.byteLength(data, 'utf8');

  return { stored: framed.records.length, rotated, missed, pending: Boolean(cursor.pending) };
}

// The panel no longer runs a collector loop; these remain so the routes and
// the app bootstrap keep one shape while the last of the pull path is removed
// in m5.
export async function startLogCollector() { return false; }
export function stopLogCollector() {}
