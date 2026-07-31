// iter10 m3 — searching the warehouse.
//
// The templating is the load-bearing part: it decides whether an operator sees
// 142 rows or 163,628. It was chosen by measurement against the real file from
// srv-mediaserver2, and the lines below are verbatim from it — a test written
// against invented log lines would certify a function that has never met the
// data it exists for.
import assert from 'node:assert/strict';
import { templateOf, maskSecrets, buildFilter, CATEGORIES, categoryOf, subsForCategory } from '../src/services/logQuery.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

console.log('TEMPLATING (verbatim lines from the real log):');

const SRT = (ip, port, sock, err) =>
  `connection closed for [${ip}:${port}] socket=${sock} errno=2002 srterror=[${err}]`;

check('the same failure from different peers collapses to one row', () => {
  const a = templateOf(SRT('192.168.200.23', 14331, 605423079, 'Connection does not exist'));
  const b = templateOf(SRT('192.168.200.24', 51200, 991233112, 'Connection does not exist'));
  assert.equal(a, b);
});

check('DIFFERENT failure reasons stay apart — this is the whole point', () => {
  // Collapsing every bracket gave 2 error templates on the real file;
  // collapsing only bracketed spans containing a digit gave 4. The extra two
  // are the difference between "SRT closed 15,237 connections" and knowing
  // which three things actually went wrong.
  const seen = new Set([
    templateOf(SRT('10.0.0.1', 1, 2, 'Connection does not exist')),
    templateOf(SRT('10.0.0.1', 1, 2, 'Connection was broken')),
    templateOf(SRT('10.0.0.1', 1, 2, 'Operation not supported: Invalid socket ID')),
  ]);
  assert.equal(seen.size, 3, 'a reason is a diagnosis, not noise');
});

check('quoted identifiers collapse, so per-stream lines group', () => {
  const a = templateOf("add HLS chunk app='cct_feeds' stream='feed1' duration=6.0 start=4338033 key=''");
  const b = templateOf("add HLS chunk app='ses' stream='atp_feed9' duration=6.0 start=99 key=''");
  assert.equal(a, b);
});

check('decimals collapse as one number, not two', () => {
  assert.equal(templateOf('duration=6.0 size=5261368'), templateOf('duration=12.5 size=7'));
  assert.ok(!templateOf('duration=6.0').includes('N.N'), 'a decimal must not become two placeholders');
});

check('hex handles and pointers collapse', () => {
  assert.equal(
    templateOf('connection closed by s=220 (ev=0x2010)'),
    templateOf('connection closed by s=7 (ev=0xffff)'),
  );
});

check('the text of a message is preserved, so groups stay readable', () => {
  const tpl = templateOf(SRT('1.2.3.4', 9, 9, 'Connection does not exist'));
    assert.match(tpl, /^connection closed for \[#\] socket=N errno=N srterror=\[Connection does not exist\]$/);
});

check('genuinely different messages never merge', () => {
  const a = templateOf('add_chunk key=\'/x.ts\' duration=6,0 size=5261368');
  const b = templateOf('inactive rtmp socket removed [10.0.0.1:1935], url=rtmp://h/a/b');
  assert.notEqual(a, b);
});

check('a long message is bounded, so one runaway line cannot blow up the view', () => {
  assert.ok(templateOf('x'.repeat(5000)).length <= 300);
});

check('empty and missing input do not throw', () => {
  assert.equal(templateOf(''), '');
  assert.equal(templateOf(null), '');
  assert.equal(templateOf(undefined), '');
});

console.log('\nSECRETS IN LOG LINES:');

check('a stream key in a publish URL is masked in the summary', () => {
  // Real: Nimble logs publish URLs, and a Nimble publish URL carries the key.
  // The warehouse keeps what the server wrote; the group view is a summary
  // shown wide, so keys do not belong in it.
  const line = 'inactive rtmp socket removed, url=rtmp://feed.example/v1/cct-a-cf?key=2CsecretValue';
  const masked = maskSecrets(line);
  assert.ok(!masked.includes('2CsecretValue'));
  assert.match(masked, /\?key=\*\*\*/);
});

check('other query parameters survive masking', () => {
  const masked = maskSecrets('url=rtmp://h/app?token=abc&bitrate=6000');
  assert.match(masked, /token=\*\*\*/);
  assert.match(masked, /bitrate=6000/);
});

console.log('\nFILTERS:');

check('an empty filter matches everything rather than nothing', () => {
  assert.deepEqual(buildFilter({}), {});
});

check('levels and subsystems become indexed $in clauses', () => {
  const f = buildFilter({ levels: ['E', 'W'], subs: ['srtpull'] });
  assert.deepEqual(f.level, { $in: ['E', 'W'] });
  assert.deepEqual(f.sub, { $in: ['srtpull'] });
});

check('empty arrays are not turned into "match nothing"', () => {
  const f = buildFilter({ levels: [], subs: [] });
  assert.ok(!('level' in f) && !('sub' in f), 'no selection means no constraint, not an empty set');
});

check('free text searches the attached HTTP dump too', () => {
  const f = buildFilter({ q: 'atp_feed1' });
  assert.equal(f.$or.length, 2);
  assert.ok(f.$or.some(c => c.cont), 'the dump is part of what the operator is looking at');
});

check('regex metacharacters in a search are literal, not a pattern', () => {
  // An operator typing a stream path must not accidentally write a regex, and
  // must not be able to write a catastrophic one.
  const f = buildFilter({ q: 'a.b*c[' });
  assert.ok(f.$or[0].msg.test('a.b*c['));
  assert.ok(!f.$or[0].msg.test('aXbbbc['), 'the dot must be a dot');
});

check('a time range becomes a bounded ts clause', () => {
  const f = buildFilter({ from: '2026-07-29T19:00:00Z', to: '2026-07-29T20:00:00Z' });
  assert.ok(f.ts.$gte instanceof Date && f.ts.$lte instanceof Date);
  assert.ok(f.ts.$gte < f.ts.$lte);
});

console.log('\nCOMPRESSION ON REAL DATA:');

check('the real file collapses by roughly three orders of magnitude', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const path = '/mnt/user-data/uploads/nimble.log';
  if (!existsSync(path)) { console.log('    (sample not present in this environment — skipped)'); return; }
  const HDR = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) P(\d+)-T(\d+)\] \[([^\]]+)\] ([A-Z]): ?([\s\S]*)$/;
  const groups = new Set();
  let records = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = HDR.exec(line);
    if (!m) continue;
    records++;
    groups.add(`${m[5].replace(/\d+$/, '')}|${m[6]}|${templateOf(m[7])}`);
  }
  assert.ok(records > 100_000, `expected the full sample, got ${records}`);
  assert.ok(groups.size < 400, `${records} records collapsed to ${groups.size} templates — too many to read`);
  assert.ok(records / groups.size > 500, 'compression must be large enough to make the view usable');
  console.log(`    (${records} records -> ${groups.size} templates)`);
});

// iter10 m4 — the functional windows.
console.log('\nCATEGORIES:');

check('every subsystem seen in the real dump lands in a window', () => {
  const seen = ['srtpull', 'util', 'srtlisten', 'work', 'remtranmgmt', 'm2ts_srt_sender',
                'livepull', 'm2ts_srt_srv', 'sync', 'rtmp', 'list', 'rtmp_sender', 'dvrmain'];
  for (const sub of seen) {
    const cat = categoryOf(sub);
    assert.notEqual(cat, 'other', `${sub} fell through to Other — the mapping is incomplete`);
  }
});

check('a subsystem nobody mapped is visible in Other, not lost', () => {
  // This dump has no WebRTC and one transcoder mode. Anything the list misses
  // must still surface somewhere, or it is a log nobody ever reads.
  assert.equal(categoryOf('webrtc_sender'), 'other');
  assert.equal(categoryOf(''), 'other');
});

check('Other is defined by exclusion, not by a list', () => {
  const f = subsForCategory('other');
  assert.ok(f.$nin, 'an $in list could never match a subsystem we have not met');
  assert.ok(f.$nin.includes('srtpull') && f.$nin.includes('remtranmgmt'));
});

check('a category expands to exactly its subsystems', () => {
  assert.deepEqual(subsForCategory('rtmp'), { $in: ['rtmp', 'rtmp_sender'] });
  assert.deepEqual(subsForCategory('transcoder'), { $in: ['remtranmgmt'] });
});

check('no subsystem belongs to two windows', () => {
  const seen = new Set();
  for (const c of CATEGORIES) {
    for (const s of c.subs) {
      assert.ok(!seen.has(s), `${s} is claimed by more than one category`);
      seen.add(s);
    }
  }
});

check('all and unknown categories mean no constraint', () => {
  assert.equal(subsForCategory('all'), null);
  assert.equal(subsForCategory(''), null);
  assert.equal(subsForCategory('nonsense'), null);
});

check('a window filter narrows to that window', () => {
  assert.deepEqual(buildFilter({ category: 'srt' }).sub,
    { $in: ['srtpull', 'srtlisten', 'm2ts_srt_sender', 'm2ts_srt_srv'] });
});

check('an explicit subsystem choice wins over the window it was made in', () => {
  // Narrowing inside the SRT window to just srtpull must not be widened back
  // out to the whole category.
  const f = buildFilter({ category: 'srt', subs: ['srtpull'] });
  assert.deepEqual(f.sub, { $in: ['srtpull'] });
});

check('the real dump is fully covered by the windows', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const path = '/mnt/user-data/uploads/nimble.log';
  if (!existsSync(path)) { console.log('    (sample not present — skipped)'); return; }
  const HDR = /^\[[\d-]+ [\d:]+ P\d+-T\d+\] \[([^\]]+)\] ([A-Z]): /;
  const counts = new Map();
  let total = 0, other = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = HDR.exec(line);
    if (!m) continue;
    total++;
    const cat = categoryOf(m[1].replace(/\d+$/, ''));
    counts.set(cat, (counts.get(cat) || 0) + 1);
    if (cat === 'other') other++;
  }
  assert.equal(other, 0, `${other} of ${total} records fell into Other`);
  assert.ok(counts.get('srt') > counts.get('rtmp'), 'sanity: SRT dominates this fleet');
  console.log(`    (${total} records, ${counts.size} windows populated, 0 uncategorised)`);
});

// Picking a server emptied every view. find() casts a string to ObjectId from
// the schema; an aggregation pipeline does not, and grouped view, facets and
// category counts are all aggregations.
console.log('\nSERVER FILTER:');

check('a server id is cast, so $match can match an ObjectId', () => {
  const f = buildFilter({ serverId: '65f1c2a3b4d5e6f7a8b9c0d1' });
  assert.equal(f.serverId.constructor.name, 'ObjectId',
    'a raw string in a pipeline compares against ObjectId and matches nothing');
  assert.equal(String(f.serverId), '65f1c2a3b4d5e6f7a8b9c0d1');
});

check('an already-cast id passes through untouched', async () => {
  const mongoose = (await import('mongoose')).default;
  const oid = new mongoose.Types.ObjectId();
  assert.equal(String(buildFilter({ serverId: oid }).serverId), String(oid));
});

check('an id that is not an ObjectId matches nothing rather than everything', () => {
  const f = buildFilter({ serverId: 'not-an-id' });
  assert.ok(f.serverId, 'the constraint must stay, or the view silently widens to the fleet');
  assert.equal(String(f.serverId), '000000000000000000000000');
});

check('no server selected means no constraint at all', () => {
  assert.ok(!('serverId' in buildFilter({})));
});

// A capped collection returns insertion order, so `$limit` with no `$sort` in
// front of it takes the OLDEST matching records. The grouped view was
// summarising the start of the window rather than the present, and nothing
// said so — it just looked like a quiet server.
console.log('\nSCAN BOUNDS:');

const source = await (async () => {
  const { readFileSync } = await import('node:fs');
  return readFileSync(new URL('../src/services/logQuery.js', import.meta.url), 'utf8');
})();

check('every capped pipeline sorts before it limits', () => {
  // $limit must never appear without a $sort ahead of it in the same stage
  // list, or the cap silently selects by insertion order.
  const limits = [...source.matchAll(/\$limit: SCAN_CAP/g)].length;
  assert.equal(limits, 1, 'the cap must exist in exactly one place — NEWEST_FIRST');
  const sortAt = source.indexOf('$sort: { ts: -1 }');
  const limitAt = source.indexOf('$limit: SCAN_CAP');
  assert.ok(sortAt > 0 && sortAt < limitAt, 'the sort must come before the limit, or the cap picks the oldest');
  // And every pipeline reaches the cap through that constant.
  assert.equal([...source.matchAll(/\.\.\.NEWEST_FIRST/g)].length, 3,
    'group, facets and category counts must all be bounded the same way');
});

check('all three aggregation entry points go through the bounded runner', () => {
  const direct = [...source.matchAll(/LogRecord\.aggregate\(/g)].length;
  assert.equal(direct, 1, 'only run() may call aggregate, so nothing escapes the time bound');
  assert.ok(source.includes('maxTimeMS'), 'a pipeline must not outlive the proxy in front of it');
});

check('facets are one pass, not three', () => {
  // Three pipelines over the same match meant scanning the same records three
  // times for one screen — a third of the 504s on their own.
  assert.ok(source.includes('$facet'), 'the three groupings share one scan');
  assert.ok(source.includes('byLevel:') && source.includes('bySub:') && source.includes('byServer:'));
});

check('a timeout is reported as a filter problem, not a server fault', async () => {
  const { tooWide } = await import('../src/services/logQuery.js');
  assert.equal(tooWide(new Error('operation exceeded time limit')), true);
  assert.equal(tooWide(new Error('PlanExecutor error: MaxTimeMSExpired')), true);
  assert.equal(tooWide(new Error('connection refused')), false);
  assert.equal(tooWide(null), false);
});

check('raw rows order by offset within a server and by time across the fleet', () => {
  // Offsets are byte positions in one server's file; they are not comparable
  // between servers, and Nimble's one-second stamps cannot order 98 lines/s
  // within one.
  assert.ok(source.includes("opts.serverId ? { gen: -1, offset: -1 } : { ts: -1 }"));
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall log-query checks passed');
process.exit(fail ? 1 : 0);
