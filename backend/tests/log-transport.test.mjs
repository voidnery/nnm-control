// iter10 m1 — log framing and ingestion.
//
// The fixtures below are verbatim lines from srv-mediaserver2's nimble.log
// (2026-07-29 19:14). Nothing here is invented: the format has no published
// specification, so a test written against an imagined format would certify
// the wrong thing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frameRecords, baseSubsystem, levelRank, toDate, LOG_HEADER } from '../src/services/logParser.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

const L = (s) => s + '\n';
const SRT_ERR = '[2026-07-29 19:14:49 P433506-T433515] [srtpull0] E: connection closed for [192.168.200.23:14331] socket=605423079 errno=2002 srterror=[Connection does not exist]';
const HLS_DBG = "[2026-07-29 19:14:49 P433506-T433516] [srtlisten0] D: add HLS chunk app='cct_feeds' stream='feed1' duration=6.0 start=4338033 key=''";
const TC_DBG  = "[2026-07-29 19:14:50 P433506-T433737] [remtranmgmt] D: add_chunk key='/cct_feed/feed1_cf_logo/l_22105_4338033_723.ts' duration=6,0 size=5261368";
const WORK_V  = '[2026-07-29 19:46:06 P433506-T433507] [work1] V: connection closed by s=220 (ev=0x2010)';
// A real HTTP dump: the header line is followed by bare lines with no stamp.
const HTTP_BLOCK = L('[2026-07-29 19:14:54 P433506-T433507] [work1] D: cli s=217 req (96B):')
  + L('GET /ses/atp_feed1/playlist.m3u8 HTTP/1.1')
  + L('Host: 192.168.200.15:8081')
  + L('Connection: keep-alive')
  + L('');

console.log('HEADER SHAPE (pinned from the real dump):');

check('a line with pid, thread, subsystem and level parses', () => {
  const m = LOG_HEADER.exec(SRT_ERR);
  assert.ok(m, 'header did not match');
  assert.equal(m[1], '2026-07-29');
  assert.equal(m[3], '433506');
  assert.equal(m[4], '433515');
  assert.equal(m[5], 'srtpull0');
  assert.equal(m[6], 'E');
  assert.match(m[7], /^connection closed for/);
});

check('brackets inside the message do not truncate the subsystem', () => {
  const r = frameRecords(L(SRT_ERR), 0, null, { flush: true }).records[0];
  assert.equal(r.tag, 'srtpull0');
  assert.match(r.msg, /srterror=\[Connection does not exist\]$/);
});

check('every level letter observed in the sample is accepted', () => {
  for (const [line, lvl] of [[SRT_ERR, 'E'], [HLS_DBG, 'D'], [WORK_V, 'V']]) {
    assert.equal(frameRecords(L(line), 0, null, { flush: true }).records[0].level, lvl);
  }
});

check('an undocumented level letter is kept, not discarded', () => {
  const odd = '[2026-07-29 19:14:49 P1-T2] [util] W: something new';
  const r = frameRecords(L(odd), 0, null, { flush: true }).records[0];
  assert.equal(r.level, 'W');
  assert.ok(levelRank('W') > levelRank('I'));
  assert.ok(levelRank('Z') > levelRank('I'), 'unknown letters must not sort as trivia');
});

console.log('\nSUBSYSTEM NORMALISATION (15 raw tags -> 13 real subsystems):');

check('the thread index is stripped', () => {
  assert.equal(baseSubsystem('srtpull0'), 'srtpull');
  assert.equal(baseSubsystem('work1'), 'work');
  assert.equal(baseSubsystem('rtmp_sender4'), 'rtmp_sender');
});

check('tags without an index are untouched', () => {
  for (const t of ['util', 'remtranmgmt', 'm2ts_srt_sender', 'sync', 'dvrmain', 'rtmp'])
    assert.equal(baseSubsystem(t), t);
});

check('a purely numeric tag is not erased', () => {
  assert.equal(baseSubsystem('4'), '4');
});

console.log('\nMULTI-LINE RECORDS (11.3% of the sample is continuation text):');

check('an HTTP dump attaches to the record above it', () => {
  const { records } = frameRecords(HTTP_BLOCK, 0, null, { flush: true });
  assert.equal(records.length, 1, 'the dump must not become four records');
  assert.equal(records[0].contLines, 4);
  assert.match(records[0].cont, /^GET \/ses\/atp_feed1\/playlist\.m3u8/);
});

check('a record is not emitted while its dump may still be arriving', () => {
  const r = frameRecords(HTTP_BLOCK, 0, null);   // no flush = mid-file
  assert.equal(r.records.length, 0);
  assert.ok(r.pending, 'the open record must be carried, not dropped');
});

check('a dump split across two polls is stored once, whole', () => {
  const first = frameRecords(L('[2026-07-29 19:14:54 P1-T2] [work1] D: cli s=217 req (96B):') + L('GET / HTTP/1.1'), 0, null);
  assert.equal(first.records.length, 0);
  const second = frameRecords(L('Host: x') + L(SRT_ERR), first.nextOffset, first.pending, { flush: true });
  assert.equal(second.records.length, 2);
  assert.equal(second.records[0].contLines, 2, 'both halves of the dump belong to one record');
  assert.equal(second.records[0].cont, 'GET / HTTP/1.1\nHost: x');
});

check('text before the first header is kept as an orphan, never dropped', () => {
  const { records } = frameRecords(L('Connection: keep-alive') + L(SRT_ERR), 0, null, { flush: true });
  assert.equal(records.length, 2);
  assert.equal(records[0].orphan, true);
  assert.equal(records[1].orphan, undefined);
});

console.log('\nOFFSETS (ordering cannot use timestamps — 98 lines/s at 1s resolution):');

check('offsets are absolute byte positions in the file', () => {
  const text = L(SRT_ERR) + L(HLS_DBG) + L(TC_DBG);
  const { records } = frameRecords(text, 1000, null, { flush: true });
  assert.equal(records[0].offset, 1000);
  assert.equal(records[1].offset, 1000 + Buffer.byteLength(SRT_ERR) + 1);
  assert.equal(records[2].offset, 1000 + Buffer.byteLength(SRT_ERR) + 1 + Buffer.byteLength(HLS_DBG) + 1);
});

check('offsets count bytes, not characters', () => {
  const wide = '[2026-07-29 19:14:49 P1-T2] [util] V: канал переключён';
  const { records } = frameRecords(L(wide) + L(SRT_ERR), 0, null, { flush: true });
  assert.equal(records[1].offset, Buffer.byteLength(wide, 'utf8') + 1);
  assert.notEqual(records[1].offset, wide.length + 1, 'character counting would desync the cursor');
});

check('a hundred records sharing one timestamp stay ordered by offset', () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    L(`[2026-07-29 19:14:49 P1-T2] [srtpull0] D: line ${i}`)).join('');
  const { records } = frameRecords(many, 0, null, { flush: true });
  assert.equal(new Set(records.map(r => r.raw)).size, 1, 'fixture must share one stamp');
  assert.equal(new Set(records.map(r => r.offset)).size, 100, 'offsets must still be unique');
  for (let i = 1; i < records.length; i++) assert.ok(records[i].offset > records[i - 1].offset);
});

console.log('\nTIMESTAMPS (local time, no zone marker in the file):');

check('a stamp with no server offset is read as UTC', () => {
  assert.equal(toDate('2026-07-29T19:14:49').toISOString(), '2026-07-29T19:14:49.000Z');
});

check('a server offset shifts the stamp to real UTC', () => {
  assert.equal(toDate('2026-07-29T19:14:49', 180).toISOString(), '2026-07-29T16:14:49.000Z');
});

check('an unparsable stamp yields null rather than Invalid Date', () => {
  assert.equal(toDate(null), null);
  assert.equal(toDate('not a date'), null);
});

console.log('\nCOLLECTOR (against a fake agent):');

// A fake agent that serves a growing, rotatable file the way the real one
// does — including trimming every read to a whole number of lines.
function fakeAgent(initial = '') {
  const st = { body: Buffer.from(initial), ino: '1', reads: 0 };
  return {
    st,
    logsList: async () => ({ dir: '/var/log/nimble', exists: true,
      files: [{ name: 'nimble.log', size: st.body.length, ino: st.ino, mtime: new Date() }] }),
    logsRead: async (_s, name, offset, limit) => {
      st.reads++;
      if (offset > st.body.length) return { name, ino: st.ino, size: st.body.length, offset, nextOffset: 0, truncated: true, eof: true, data: '' };
      const end = Math.min(st.body.length, offset + limit);
      let slice = st.body.subarray(offset, end);
      const nl = slice.lastIndexOf(0x0a);
      slice = nl === -1 ? slice.subarray(0, 0) : slice.subarray(0, nl + 1);
      return { name, ino: st.ino, size: st.body.length, offset,
               nextOffset: offset + slice.length, eof: offset + slice.length >= st.body.length,
               data: slice.toString('utf8') };
    },
    append(text) { st.body = Buffer.concat([st.body, Buffer.from(text)]); },
    rotate(text) { st.body = Buffer.from(text); st.ino = String(Number(st.ino) + 1); },
  };
}

await acheck('the agent never hands back half a line', async () => {
  const a = fakeAgent(L(SRT_ERR) + '[2026-07-29 19:14:50 P1-T2] [util] V: incompl');
  const r = await a.logsRead(null, 'nimble.log', 0, 1024);
  assert.ok(r.data.endsWith('\n'));
  assert.equal(r.nextOffset, Buffer.byteLength(SRT_ERR) + 1);
  assert.equal(r.eof, false, 'the unterminated tail is still pending');
});

await acheck('a read past the end reports truncation instead of garbage', async () => {
  const a = fakeAgent(L(SRT_ERR));
  const r = await a.logsRead(null, 'nimble.log', 99999, 1024);
  assert.equal(r.truncated, true);
  assert.equal(r.nextOffset, 0);
});

await acheck('rotation is visible as a changed inode', async () => {
  const a = fakeAgent(L(SRT_ERR));
  const before = (await a.logsList()).files[0];
  a.rotate(L(HLS_DBG));
  const after = (await a.logsList()).files[0];
  assert.notEqual(before.ino, after.ino, 'a new generation must be distinguishable');
  assert.ok(Number(after.size) < 99999);
});

await acheck('polling a growing file yields each record exactly once', async () => {
  const a = fakeAgent('');
  let off = 0, pending = null;
  const seen = [];
  const poll = async () => {
    for (;;) {
      const c = await a.logsRead(null, 'nimble.log', off, 1024 * 1024);
      if (!c.data) break;
      const f = frameRecords(c.data, off, pending, { flush: Boolean(c.eof) });
      pending = f.pending;
      seen.push(...f.records);
      off = pending ? pending.offset : c.nextOffset;
      if (c.eof) break;
    }
  };
  a.append(L(SRT_ERR) + L(HLS_DBG));
  await poll();
  a.append(L(TC_DBG));
  await poll();
  a.append(HTTP_BLOCK);
  await poll();
  assert.equal(seen.length, 4, `expected 4 records, got ${seen.length}`);
  assert.equal(new Set(seen.map(r => r.offset)).size, 4, 'no record may be stored twice');
  assert.equal(seen[3].contLines, 4, 'the dump appended last must be complete');
});

// iter12 m2 — the tail moved to the agent, which ships batches instead of
// answering byte-range reads. Framing stayed on the panel, so the property to
// pin is that a stream of pushed batches reconstructs exactly the records the
// whole file would have produced.
console.log('\nPUSH BATCHES (agent ships, panel frames):');

// Stand-in for the agent's tailer: same rules as the real one — batches end on
// a line boundary, the cursor only advances after a successful ship.
function tailer(text, batchBytes) {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  return {
    get offset() { return offset; },
    next() {
      if (offset >= buf.length) return null;
      const full = offset + batchBytes <= buf.length;
      let end = Math.min(offset + batchBytes, buf.length);
      const nl = buf.lastIndexOf(0x0a, end - 1);
      if (nl >= offset) end = nl + 1;
      else if (!full) return null;      // unterminated tail still being written
      // else: a single line longer than a whole batch. The agent ships it
      // rather than wedging the tail forever; framing degrades for that one
      // record, which is the better of two bad outcomes and only reachable if
      // the batch size is set below the length of a log line.
      return { offset, data: buf.subarray(offset, end).toString('utf8') };
    },
    commit(batch) { offset = batch.offset + Buffer.byteLength(batch.data, 'utf8'); },
  };
}

// Panel side: exactly what ingestBatch does with framing and the pending carry.
function receiver() {
  const records = [];
  let pending = null;
  let at = 0;
  let missed = 0;
  return {
    records, get missed() { return missed; },
    take({ offset, data }) {
      if (at && offset > at) { missed += offset - at; pending = null; }
      if (offset < at) return 'duplicate';
      const f = frameRecords(data, offset, pending, { flush: false });
      pending = f.pending;
      records.push(...f.records);
      at = offset + Buffer.byteLength(data, 'utf8');
      return 'stored';
    },
  };
}

const STREAM = L(SRT_ERR) + HTTP_BLOCK + L(TC_DBG) + L(WORK_V) + HTTP_BLOCK + L(HLS_DBG);
const WHOLE = frameRecords(STREAM, 0, null, { flush: true }).records;

check('a pushed stream reconstructs exactly what parsing the file would give', () => {
  for (const size of [200, 512, 4096, 100000]) {
    const t = tailer(STREAM, size);
    const r = receiver();
    for (;;) { const b = t.next(); if (!b) break; r.take(b); t.commit(b); }
    // The last record stays open until the next header or EOF, which is
    // correct: its continuation lines may still be arriving.
    assert.equal(r.records.length, WHOLE.length - 1, `batch size ${size}`);
    for (let i = 0; i < r.records.length; i++) {
      assert.equal(r.records[i].offset, WHOLE[i].offset, `offset mismatch at ${i}, batch ${size}`);
      assert.equal(r.records[i].msg, WHOLE[i].msg, `msg mismatch at ${i}, batch ${size}`);
      assert.equal(r.records[i].cont || '', WHOLE[i].cont || '', `dump mismatch at ${i}, batch ${size}`);
    }
  }
});

check('an HTTP dump split across two batches is stored once, whole', () => {
  const t = tailer(STREAM, 240);
  const r = receiver();
  for (;;) { const b = t.next(); if (!b) break; r.take(b); t.commit(b); }
  const withDump = r.records.filter(x => x.contLines);
  assert.ok(withDump.length >= 1);
  for (const rec of withDump) assert.equal(rec.contLines, 4, 'every dump must arrive complete');
});

check('a failed ship does not advance the cursor, and the retry is not a duplicate', () => {
  const t = tailer(STREAM, 200);
  const r = receiver();
  const first = t.next();
  // shipping "fails": no commit
  const retry = t.next();
  assert.equal(retry.offset, first.offset, 'the retry must re-read the same bytes');
  assert.equal(r.take(retry), 'stored');
  t.commit(retry);
  assert.equal(r.take(retry), 'duplicate', 'a genuine replay must be dropped, not stored twice');
});

check('a gap is counted, not smoothed over', () => {
  const t = tailer(STREAM, 200);
  const r = receiver();
  const b1 = t.next(); r.take(b1); t.commit(b1);
  const b2 = t.next(); t.commit(b2);          // this batch is lost in flight
  const b3 = t.next(); r.take(b3);
  assert.ok(r.missed > 0, 'lost bytes must be reported');
  assert.equal(r.missed, b3.offset - (b1.offset + Buffer.byteLength(b1.data, 'utf8')));
});

console.log('\nAGENT TAILER SHAPE:');

check('the cursor and rotation detection live on the agent now', () => {
  const src = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('logcursor.json'), 'the cursor must survive a restart');
  assert.ok(src.includes('prev.ino !== ino'), 'rotation is detected by inode, on the agent');
  assert.ok(src.includes('st.size < offset'), 'in-place truncation is detected too');
  assert.ok(src.includes("panelFetch('/logs'"), 'batches are pushed, not served');
});

check('the panel no longer reads byte ranges out of agents', () => {
  const collector = readFileSync(new URL('../src/services/logCollector.js', import.meta.url), 'utf8');
  assert.ok(!collector.includes('logsRead'), 'the pull path must be gone from the collector');
  assert.ok(collector.includes('ingestBatch'));
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall log-transport checks passed');
process.exit(fail ? 1 : 0);
