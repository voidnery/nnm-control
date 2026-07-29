// iter10 m1 — pulling Nimble logs into the panel.
//
// Transport choice, decided from measurement rather than preference:
//
//   Nimble can also emit to syslog (`logging = file:info, syslog:info`), which
//   would be push instead of poll. But the sink is a nimble.conf parameter and
//   Softvelum's reference is explicit that config changes need the instance
//   RE-STARTED. That is 13 restarts of live broadcast servers plus an rsyslog
//   deployment, against an agent that has to be installed on those boxes
//   anyway. So: the agent tails files, Nimble is not touched at all, and its
//   config keeps saying exactly what it says today.
//
// Budgeting, from the same measurement: 12.8 KB/s per server. A 5s poll is
// ~64 KB, and the agent's 1 MB read window covers ~80s of output, so a poll
// that is late or a server that bursts still catches up within one cycle
// instead of falling permanently behind.
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { LogRecord, LogCursor } from '../models/LogRecord.js';
import { agent } from './agentClient.js';
import { frameRecords, toDate } from './logParser.js';

export const DEFAULT_FILES = ['nimble.log'];

// Per poll, per file. Bounds one server's ability to monopolise a cycle when
// it is catching up after an outage.
const MAX_CHUNKS_PER_POLL = 8;
const CHUNK_BYTES = 1024 * 1024;

let timer = null;
let running = false;
const state = { lastRunAt: null, lastError: '', servers: 0, records: 0, bytes: 0 };

export function collectorState() {
  return { ...state, active: Boolean(timer) };
}

async function loadCursor(serverId, file) {
  return await LogCursor.findOneAndUpdate(
    { serverId, file },
    { $setOnInsert: { offset: 0, ino: '', gen: 0 } },
    { new: true, upsert: true },
  );
}

/**
 * Ingest one file from one server. Exported so it can be driven directly by
 * tests and by the manual "ingest now" action.
 */
export async function ingestFile(server, file, { maxChunks = MAX_CHUNKS_PER_POLL, client = agent } = {}) {
  const cursor = await loadCursor(server._id, file);
  const result = { file, chunks: 0, bytes: 0, records: 0, rotated: false, missed: 0 };

  // Identify the current generation before reading a single byte.
  const listing = await client.logsList(server);
  const meta = (listing.files || []).find(f => f.name === file);
  if (!meta) {
    cursor.lastError = `file not present in ${listing.dir || 'log dir'}`;
    cursor.lastAt = new Date();
    await cursor.save();
    return { ...result, error: cursor.lastError };
  }

  // Rotation: same name, different inode. Everything between our cursor and
  // the end of the old file is gone — the rotated copy is nimble.log.1, which
  // the agent does not serve because its extension is not a log extension.
  // That loss is reported rather than quietly skipped, because "the tail has
  // a hole in it" is exactly the kind of thing an operator must not discover
  // during an incident.
  if (cursor.ino && meta.ino !== cursor.ino) {
    result.rotated = true;
    result.missed = Math.max(0, Number(meta.sizeBefore || 0) - cursor.offset);
    cursor.rotations += 1;
    cursor.bytesMissed += result.missed;
    cursor.offset = 0;
    cursor.gen += 1;
    cursor.pending = null;
  }
  // Truncation in place (copytruncate-style): the file is shorter than our
  // cursor, so it is a new generation under the same inode.
  if (Number(meta.size) < cursor.offset) {
    result.rotated = true;
    cursor.rotations += 1;
    cursor.offset = 0;
    cursor.gen += 1;
    cursor.pending = null;
  }
  cursor.ino = meta.ino;

  // A cursor seeded at 0 on a 128 MB file would replay the whole history at
  // once. First contact starts at the end: m1 is a tail, not an importer.
  if (!cursor.lastAt && cursor.offset === 0 && Number(meta.size) > CHUNK_BYTES) {
    cursor.offset = Number(meta.size);
  }

  let pending = cursor.pending || null;
  try {
    for (let i = 0; i < maxChunks; i++) {
      const chunk = await client.logsRead(server, file, cursor.offset, CHUNK_BYTES);
      if (chunk.truncated) {
        result.rotated = true;
        cursor.rotations += 1;
        cursor.offset = 0; cursor.gen += 1; pending = null;
        continue;
      }
      if (!chunk.data) break;

      result.chunks++;
      result.bytes += Buffer.byteLength(chunk.data, 'utf8');

      // flush only at end of file: mid-file, a record's continuation lines may
      // still be arriving in the next chunk.
      const framed = frameRecords(chunk.data, cursor.offset, pending, { flush: Boolean(chunk.eof) });
      pending = framed.pending;

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
        result.records += framed.records.length;
      }

      // Advance past what was consumed. When a record is still open its bytes
      // are NOT consumed — the cursor stops at its start so the next poll
      // re-reads and completes it.
      cursor.offset = Number(chunk.nextOffset);
      if (pending) cursor.offset = pending.offset;
      if (chunk.eof) break;
    }
    cursor.lastError = '';
  } catch (e) {
    cursor.lastError = e.message;
    result.error = e.message;
  }

  cursor.pending = pending;
  cursor.bytesRead += result.bytes;
  cursor.recordsStored += result.records;
  cursor.lastAt = new Date();
  await cursor.save();
  return result;
}

export async function collectOnce({ client = agent } = {}) {
  const s = await Settings.load();
  const cfg = s.logs || {};
  const files = (cfg.files && cfg.files.length ? cfg.files : DEFAULT_FILES);

  const servers = await NimbleServer.find({ 'agent.enabled': true });
  const out = { servers: 0, records: 0, bytes: 0, errors: [] };

  for (const server of servers) {
    let touched = false;
    for (const file of files) {
      try {
        const r = await ingestFile(server, file, { client });
        out.records += r.records;
        out.bytes += r.bytes;
        if (r.error) out.errors.push(`${server.name}/${file}: ${r.error}`);
        touched = true;
      } catch (e) {
        out.errors.push(`${server.name}/${file}: ${e.message}`);
      }
    }
    if (touched) out.servers++;
  }

  state.lastRunAt = new Date();
  state.lastError = out.errors[0] || '';
  state.servers = out.servers;
  state.records += out.records;
  state.bytes += out.bytes;
  return out;
}

export async function startLogCollector() {
  const s = await Settings.load();
  const cfg = s.logs || {};
  stopLogCollector();
  if (!cfg.enabled) return false;
  const everyMs = Math.max(2, Number(cfg.intervalSec || 5)) * 1000;
  const tick = async () => {
    if (running) return;                 // a slow cycle must not stack
    running = true;
    try { await collectOnce(); }
    catch (e) { state.lastError = e.message; }
    finally { running = false; }
  };
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
  tick();
  return true;
}

export function stopLogCollector() {
  if (timer) { clearInterval(timer); timer = null; }
}
