// iter16 m1 — pairing Nimble's live stats with WMSPanel's objects.
//
// The field names are not documented and differ between builds, and guessing
// them has cost this project twice. So the join discovers its own key, and
// what is tested is that behaviour: that it finds a key when one exists,
// prefers the stronger of two, and says so plainly when none does.
import assert from 'node:assert/strict';
import { joinLive, liveSummary } from '../src/services/streamJoin.js';

let pass = 0, fail = 0;
const check = (n, f) => {
  try { f(); console.log(`  ✓ ${n}`); pass++; }
  catch (e) { console.log(`  ✗ ${n}: ${e.message}`); fail++; }
};

const wms = [
  { id: 'w1', name: 'CCT_FEED1_EU_BACKUP', ip: '78.17.115.133', port: 18001 },
  { id: 'w2', name: 'BLAST SLAM VII - KK Feed - Stream A', ip: '0.0.0.0', port: 21041 },
];

console.log('FINDING THE KEY:');

check('matches on name when Nimble reports one', () => {
  const r = joinLive([{ name: 'CCT_FEED1_EU_BACKUP', bandwidth: 6.2 }], wms);
  assert.equal(r.strategy, 'name');
  assert.equal(r.matched, 1);
  assert.ok(r.byObjectId.w1);
});

check('falls back to the socket address when it does not', () => {
  const r = joinLive([{ id: '7712', ip: '78.17.115.133', port: 18001, bitrate: 6.2e6 }], wms);
  assert.equal(r.strategy, 'address');
  assert.ok(r.byObjectId.w1);
});

check('a listener is identified by its port alone', () => {
  // 0.0.0.0:21041 and :21041 are the same socket; requiring the host to match
  // would leave every listen-mode stream unmatched.
  const r = joinLive([{ ip: '0.0.0.0', port: 21041, bandwidth: 4 }], wms);
  assert.equal(r.matched, 1);
  assert.ok(r.byObjectId.w2);
});

check('a stronger key wins over a weaker one', () => {
  // Both would match here. Name identifies a stream; a port can be reused.
  const r = joinLive([{ name: 'CCT_FEED1_EU_BACKUP', ip: '78.17.115.133', port: 18001 }], wms);
  assert.equal(r.strategy, 'name');
});

check('an empty field never matches', () => {
  // An empty key matches everything, which is worse than matching nothing.
  const r = joinLive([{ name: '', stream: '', id: '' }], [{ id: 'w9', name: '' }]);
  assert.equal(r.matched, 0);
});

console.log('\nWHEN NOTHING FITS:');

check('it says so, and keeps the evidence', () => {
  // This is the case the whole design exists for: unmatched objects and an
  // offline stream look identical in a table, and only one is a panel problem.
  const entries = [{ socket_id: 5, mbpsRate: 6.1, peer: 'x' }];
  const r = joinLive(entries, wms);
  assert.equal(r.strategy, '');
  assert.equal(r.matched, 0);
  assert.deepEqual(r.unmatchedObjects, ['w1', 'w2']);
  assert.deepEqual(r.unmatchedEntries, entries, 'the only evidence of what the fields are called');
  assert.ok(r.candidates.every(c => c.matched === 0));
});

check('the evidence is bounded', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ socket_id: i }));
  assert.equal(joinLive(many, wms).unmatchedEntries.length, 10);
});

check('empty input is not an error', () => {
  assert.equal(joinLive([], []).matched, 0);
  assert.equal(joinLive().matched, 0);
});

console.log('\nREADING A VALUE OUT OF WHATEVER SHAPE IT HAS:');

check('the rate is read from where Nimble actually puts it', () => {
  // stats.recv.mbpsRate for a receiver, stats.send.mbpsRate for a sender.
  // These were guesses at flat fields until a live capture settled it.
  assert.equal(liveSummary({ stats: { recv: { mbpsRate: 6.2 } } }).bps, 6_200_000);
  assert.equal(liveSummary({ stats: { send: { mbpsRate: 6.2 } } }).bps, 6_200_000);
  assert.equal(liveSummary({ bitrate: 6_200_000 }).bps, 6_200_000, 'a flat bps field still works');
});

check('online follows the socket state, and data implies it', () => {
  assert.equal(liveSummary({ state: 'connected' }).online, true);
  assert.equal(liveSummary({ state: 'disconnected' }).online, false);
  assert.equal(liveSummary({ stats: { recv: { mbpsRate: 6 } } }).online, true, 'data means live');
});

check('a missing rate is null, not zero', () => {
  // Zero reads as "carrying nothing", which is a different fact from "did not
  // report".
  assert.equal(liveSummary({ rtt: 12 }).bps, null);
  assert.equal(liveSummary(null), null);
});

console.log('\nREADING STATS IS NOT CONTROLLING:');

const { readFileSync } = await import('node:fs');
const routeSrc = readFileSync(new URL('../src/routes/nimbleProxy.js', import.meta.url), 'utf8');
const tabsSrc = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');

check('the control-plane guard no longer blocks reading counters', () => {
  // The guard exists so control does not go two ways at once — a native change
  // is overwritten on WMSPanel's next sync. Reading a counter is not a change,
  // and the stats collector has polled this same API in this same mode all
  // along, so the block made the panel refuse itself data it already had.
  const RO = [/^\/[^/]+\/live-objects\//];
  const allowed = (p) => RO.some(re => re.test(p));
  assert.equal(allowed('/S1/live-objects/incoming'), true);
  assert.equal(allowed('/S1/manage/reload_config'), false, 'control stays blocked');
  assert.equal(allowed('/S1/sessions'), false);
  assert.ok(routeSrc.includes('const READ_ONLY = ['), 'and the rule is in the route, not only here');
});

check('a failed request shows why instead of blanking the table', () => {
  // With the error swallowed, a 409 from that guard was indistinguishable from
  // "every stream is offline" — for a whole release.
  assert.ok(tabsSrc.includes('setLive({ available: false, reason: e.message })'));
  assert.ok(!/catch\(\(\) => \{ if \(!dead\) setLive\(null\)/.test(tabsSrc));
});

console.log('\nFINDING THE LIST WHEREVER NIMBLE PUT IT:');

const asList = (d) => {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (const k of ['streams', 'sockets', 'stats', 'rules']) if (Array.isArray(d[k])) return d[k];
  for (const v of Object.values(d)) {
    if (Array.isArray(v) && (v.length === 0 || (v[0] && typeof v[0] === 'object'))) return v;
  }
  const vals = Object.entries(d).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
  if (vals.length && vals.every(([, v]) => Object.values(v).some(x => typeof x === 'number'))) {
    return vals.map(([k, v]) => ({ ...v, _key: k, name: v.name ?? k }));
  }
  return [];
};

check('a key we have not seen before still yields the list', () => {
  // A fixed list of key names is what produced "0 live streams" against 76
  // configured. There is only ever one array of objects at the top level.
  assert.equal(asList({ SrtReceiverStats: [{ name: 'a' }] }).length, 1);
  assert.equal(asList([{ name: 'a' }]).length, 1);
});

check('an object keyed by stream name becomes a list, keeping the key', () => {
  // Some endpoints key by stream or port rather than listing — and that key is
  // often the only identifier there is, so it must not be thrown away.
  const out = asList({ CCT_FEED4_EU_BACKUP: { bitrate: 6.2, rtt: 12 } });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'CCT_FEED4_EU_BACKUP', 'the key becomes the name the join can match on');
});

check('a status envelope is not mistaken for data', () => {
  assert.deepEqual(asList({ status: 'Ok' }), []);
  assert.deepEqual(asList({ streams: [] }), []);
});

check('"nothing came back" is reported apart from "did not line up"', () => {
  // Only the first is answered by the shape of the response; conflating them
  // sends the operator looking in the wrong place.
  const tabs = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');
  assert.ok(tabs.includes('const empty = live.entries === 0'));
  assert.ok(tabs.includes("t('wo.liveEmpty'") && tabs.includes("t('wo.liveNoMatch'"));
  assert.ok(routeSrc.includes('responseShape: entries.length === 0'));
});

check('the shape carries names and types, never values', () => {
  // It crosses a screen, and a stats response can carry addresses.
  const from = routeSrc.indexOf('const shapeOf =');
  const body = routeSrc.slice(from, routeSrc.indexOf('};', routeSrc.indexOf('return { type: typeof v }', from)));
  assert.ok(body.includes('Object.keys(v)'));
  assert.ok(!/Object\.values\(v\)\.slice/.test(body), 'values must not be copied into the shape');
});

// Everything above reasons about shapes I guessed at. This part runs against a
// response captured from a live server, which is the only thing that settles
// what the fields are called.
console.log('\nAGAINST A REAL NIMBLE RESPONSE:');

const real = JSON.parse(readFileSync(new URL('./fixtures/srt-receiver-stats.json', import.meta.url), 'utf8'));

check('the key is setting_id, and it is the WMSPanel object id', () => {
  // Nimble's own `id` field is a socket pair — "31.28.6.149:60317->0.0.0.0:35001"
  // — which identifies a connection, not a configured stream. Matching on it
  // would have paired nothing, and that is what "0 matched of 76" was.
  const objects = real.map(e => ({ id: e.setting_id, name: 'x' }));
  const r = joinLive(real, objects);
  assert.equal(r.strategy, 'setting_id');
  assert.equal(r.matched, real.length, 'every entry pairs');
  assert.match(real[0].id, /^[\d.]+:\d+/, 'the id field really is a socket pair');
});

check('the bitrate is the stream, not the link', () => {
  // stats.link.mbpsBandwidth is the link's estimated capacity: 2444 Mbps on an
  // 8 Mbps feed. Putting that in a bitrate column would be wrong in a way that
  // looks entirely plausible.
  const live = real.find(e => e.stats?.recv?.mbpsRate > 0);
  const s = liveSummary(live);
  assert.ok(Math.abs(s.bps - live.stats.recv.mbpsRate * 1e6) < 1);
  assert.ok(s.bps < 20e6, `read ${(s.bps / 1e6).toFixed(1)} Mbps, not the ${live.stats.link.mbpsBandwidth} Mbps link`);
});

check('connected-but-silent is its own state', () => {
  // Two of the seven connected sockets carry nothing. Folding that into
  // "offline" would hide a stream that is up and not delivering — the case an
  // operator most wants to catch.
  const idle = real.filter(e => e.state === 'connected' && e.stats?.recv?.mbpsRate === 0);
  assert.ok(idle.length > 0, 'the capture contains this case');
  const s = liveSummary(idle[0]);
  assert.equal(s.idle, true);
  assert.equal(s.online, true, 'the socket is up');
  assert.equal(s.bps, 0, 'and carrying nothing');
});

check('a disconnected entry reads as offline with no invented numbers', () => {
  const down = real.find(e => e.state === 'disconnected');
  const s = liveSummary(down);
  assert.equal(s.online, false);
  assert.equal(s.bps, null, 'null, not zero — it did not report, which is not the same as reporting nothing');
  assert.equal(s.rtt, null);
});

check('loss is a ratio of what arrived, not a raw count', () => {
  const live = real.find(e => e.stats?.recv?.packetsLost > 0);
  const s = liveSummary(live);
  const { packetsReceived: got, packetsLost: lost } = live.stats.recv;
  assert.ok(Math.abs(s.loss - (100 * lost) / (got + lost)) < 1e-9);
  assert.ok(s.loss < 5, 'and lands in a plausible range for a working feed');
});

check('the retry count comes through', () => {
  // A count that climbs is a link that keeps dropping, which no instantaneous
  // reading shows.
  assert.equal(liveSummary(real[0]).retries, real[0].retryCount);
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall stream-join checks passed');
process.exit(fail ? 1 : 0);
