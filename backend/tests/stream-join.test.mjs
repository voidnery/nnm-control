// iter16 m1 — pairing Nimble's live stats with WMSPanel's objects.
//
// The field names are not documented and differ between builds, and guessing
// them has cost this project twice. So the join discovers its own key, and
// what is tested is that behaviour: that it finds a key when one exists,
// prefers the stronger of two, and says so plainly when none does.
import assert from 'node:assert/strict';
import { joinLive, liveSummary, entryIdentity } from '../src/services/streamJoin.js';
import { flattenNumbers } from '../src/services/statsCollector.js';

let pass = 0, fail = 0;
const check = (n, f) => {
  try { f(); console.log(`  ✓ ${n}`); pass++; }
  catch (e) { console.log(`  ✗ ${n}: ${e.message}`); fail++; }
};

// A synchronous runner handed an async body reports success without having
// checked anything: the promise rejects after the try block has already
// returned.
const acheck = async (n, f) => {
  try { await f(); console.log(`  ✓ ${n}`); pass++; }
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

check('"nothing came back" is still reported apart from "did not line up"', () => {
  // Four situations, four sentences. The payload behind them moved to tools/;
  // the distinction an operator acts on stayed.
  const tabs = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');
  for (const k of ['wo.liveEmpty', 'wo.liveNoMatch', 'wo.livePartial', 'wo.liveElsewhere']) {
    assert.ok(tabs.includes(k), k);
  }
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

check('an SRT socket carrying only overhead is not "delivering"', () => {
  // Observed on a live fleet: dozens of sockets at exactly 0.03 Mbps with no
  // codecs detected, beside real feeds at 6.5. A green lamp next to 0.03 makes
  // "connected" look like "working", which is the wrong end of the two
  // questions an operator is asking.
  const at = (mbps) => liveSummary({ state: 'connected', stats: { recv: { mbpsRate: mbps, packetsReceived: 1 } } });
  assert.equal(at(0.03).idle, true, 'handshake and keepalive only');
  assert.equal(at(0).idle, true);
  assert.equal(at(6.5).idle, false, 'the quietest real feed on these servers');
  assert.equal(at(13.78).idle, false);
});

check('the threshold sits in the gap the data actually shows', () => {
  // Every entry in the capture is either exactly 0 or above 8 Mbps. The
  // threshold has to land in that gap and be nowhere near either side.
  const rates = real
    .map(e => e.stats?.recv?.mbpsRate)
    .filter(v => typeof v === 'number');
  const carrying = rates.filter(v => v > 0);
  assert.ok(Math.min(...carrying) > 1, 'nothing real is anywhere near the threshold');
  assert.ok(rates.filter(v => v > 0 && v < 1).length === 0, 'and the gap is empty');
});

check('a disconnected socket is not "no media" — it is not there at all', () => {
  // Two different faults: one needs the source looked at, the other the link.
  const s = liveSummary({ state: 'disconnected' });
  assert.equal(s.idle, false);
  assert.equal(s.online, false);
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

console.log('\nONE STREAM, ONE SERIES (iter16 m2):');

const collectorSrc = readFileSync(new URL('../src/services/statsCollector.js', import.meta.url), 'utf8');

check('the series is keyed on setting_id, not on the socket pair', () => {
  // `so.id` is "31.28.6.149:60317->0.0.0.0:35001" and its source port changes
  // on every reconnect. A stream in the capture shows 52 751 retries — keyed
  // that way it produced up to 52 751 separate subjects, each holding seconds
  // of history, all of them crowding a capped collection shared by the fleet.
  // There was no usable history and no way to see that there wasn't.
  // The chain moved into entryIdentity(), shared with the join — asserted on
  // the behaviour rather than on the line that used to hold it.
  assert.ok(collectorSrc.includes('entryIdentity(so)'));
  assert.equal(entryIdentity({ setting_id: 'abc', id: 'a:1->b:2' }), 'abc', 'setting_id first');
  assert.equal(entryIdentity({ id: 'a:1->b:35001' }), 'port:35001', 'and never the socket pair itself');
});

check('one subject per stream across the whole capture', () => {
  const subjects = new Set(real.map(e => `srt-receiver:${e.setting_id ?? e.id}`));
  assert.equal(subjects.size, real.length);
  // And keyed the old way, the same capture would have produced ids that
  // change on reconnect.
  const ephemeral = real.filter(e => /^[\d.]+:\d+->/.test(e.id));
  assert.ok(ephemeral.length > 0, 'the capture contains socket-pair ids');
});

check('the metrics the charts need are already stored', () => {
  // Against the real flattener, not a copy of it — the copy kept dots and so
  // agreed with itself while the stored keys had none.
  const m = flattenNumbers(real.find(e => e.stats?.recv?.mbpsRate > 0));
  for (const k of ['stats_recv_mbpsRate', 'stats_link_rtt', 'retryCount']) {
    assert.ok(k in m, `${k} is stored`);
  }
  assert.ok(!Object.keys(m).some(k => k.includes('.')), 'no key may contain a dot');
});

console.log('\nWHY A SERIES IS EMPTY (v0.25.2):');

const statsRoute = readFileSync(new URL('../src/routes/stats.js', import.meta.url), 'utf8');
const tabsSrc2 = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');

check('the panel names the reason instead of listing possibilities', () => {
  // Collection off, server silent, stream never seen, and outside the window
  // need four different actions. The panel knows which one applies.
  assert.ok(statsRoute.includes('let collection;'));
  assert.ok(statsRoute.includes('serverLastSampleAt'));
  assert.ok(statsRoute.includes('subjectLastSampleAt'));
  for (const k of ['wo.histOff', 'wo.histNoServer', 'wo.histNeverSeen', 'wo.histOutside']) {
    assert.ok(tabsSrc2.includes(k), k);
  }
});

check('the extra queries only run when there is nothing to show', () => {
  // They are two more round trips; on a populated series they would be waste
  // on every open.
  const from = statsRoute.indexOf('let collection;');
  assert.ok(statsRoute.slice(from, from + 120).includes('if (points.length === 0)'));
});

check('a WMSPanel-sourced value is marked as such', () => {
  // The two sources format differently, and that is what revealed the join
  // silently falling back to WMSPanel's own reading. Made deliberate: when the
  // two disagree, which one is on screen matters.
  assert.ok(tabsSrc2.includes("t('wo.fromWms')"));
  assert.ok(tabsSrc2.includes('<sup className="hint">wp</sup>'));
});

console.log('\nMATCHING ON THE SOCKET, NOT THE NAME (v0.25.4):');

const { localPort } = await import('../src/services/streamJoin.js');

check('the local port is pulled out of a socket pair', () => {
  // "31.28.6.149:60317->0.0.0.0:35001" — the right-hand side is ours. The
  // left-hand port is ephemeral and means nothing.
  assert.equal(localPort('31.28.6.149:60317->0.0.0.0:35001'), 'port:35001');
  assert.equal(localPort('79.98.187.66:22213'), 'port:22213', 'a listener has no arrow');
  assert.equal(localPort(''), '');
  assert.equal(localPort('nonsense'), '');
});

check('a stream joins by port when no identifier lines up', () => {
  // Two systems can name the same stream differently and still be talking
  // about the same socket. The port is what the operator configured, so it
  // means the same on both sides.
  const objects = [{ id: 'w1', name: 'unrelated name', ip: '0.0.0.0', port: 35002 }];
  const r = joinLive(real, objects);
  assert.equal(r.strategy, 'localPort');
  assert.equal(r.matched, 1);
});

check('a name still wins over a port', () => {
  // A port can be reused after a stream is deleted; a name identifies.
  const objects = [{ id: 'w1', name: 'feed', port: 35002 }];
  const entries = [{ name: 'feed', id: 'a:1->b:9999', stats: { recv: { mbpsRate: 5 } } }];
  assert.equal(joinLive(entries, objects).strategy, 'name');
});


console.log('\nWHICH ENDPOINT HOLDS WHAT IS NOT ASSUMED (v0.25.5):');

const proxySrc = readFileSync(new URL('../src/routes/nimbleProxy.js', import.meta.url), 'utf8');

check('the SRT endpoints are asked in the same order on every tab', () => {
  // The dedupe keeps whichever list arrived first, so a per-tab order made one
  // socket into `srt-receiver:X` on one tab and `srt-sender:X` on the other —
  // two subjects for one socket, and which tab you opened decided whether the
  // history was there. The collector asks receiver then sender, always; so
  // must this.
  assert.ok(proxySrc.includes("const SRT_BOTH = ['srtReceiverStats', 'srtSenderStats']"));
  const orders = [...proxySrc.matchAll(/native: \[([^\]]+)\]/g)].map(m => m[1].trim());
  const srtOrders = orders.filter(o => o.includes('srt'));
  assert.equal(new Set(srtOrders).size, 0, 'no tab may spell its own order');
});

check('both SRT endpoints are asked, for every SRT tab', () => {
  // Ports 35001+ turned up under srt_receiver_stats while being configured as
  // UDP Streaming — SRT Out here. A fixed endpoint-per-tab map was wrong, and
  // wrong in a way that produced an empty column with a plausible explanation
  // attached to it.
  assert.equal([...proxySrc.matchAll(/native: SRT_BOTH/g)].length, 3, 'incoming, outgoing and udp');
  assert.ok(proxySrc.includes('udp:'), 'SRT Out has its own entry');
});

check('one endpoint failing does not lose the other', () => {
  // They cover different sockets; either alone is worth having.
  assert.ok(proxySrc.includes("const ok = nativeRes.filter(r => r.status === 'fulfilled')"));
  assert.ok(proxySrc.includes('if (!ok.length)'));
});

check('a socket appearing in both lists is counted once', () => {
  assert.ok(proxySrc.includes('const seen = new Set()'));
  assert.ok(proxySrc.includes('`${e.setting_id ?? \'\'}|${e.id ?? \'\'}`'));
});

console.log('\nSEVERAL SOCKETS, ONE STREAM (v0.25.6):');

const client = (mbps, rtt) => ({
  state: 'connected', retryCount: 3,
  stats: { link: { rtt }, send: { mbpsRate: mbps, packetsSent: 100, packetsLost: 1 } },
});

check('the rate of an SRT Out is the sum of its clients', () => {
  // One setting reports one socket per connected client — five entries sharing
  // a setting_id in the live capture. Keeping the last showed one viewer's
  // rate where the egress total was meant.
  const s = liveSummary([client(2, 9), client(2, 11), client(2, 40), client(2, 10), client(2, 9)]);
  assert.equal(s.bps, 10e6);
  assert.equal(s.clients, 5);
});

check('RTT and loss are worst-case, not averaged', () => {
  // One bad client is the one worth noticing, and an average hides it.
  const s = liveSummary([client(2, 9), client(2, 40)]);
  assert.equal(s.rtt, 40);
});

check('idle only when every client is', () => {
  // One viewer pulling nothing while four others work is not an idle stream.
  assert.equal(liveSummary([client(0, 9), client(0, 9)]).idle, true);
  assert.equal(liveSummary([client(0, 9), client(6, 9)]).idle, false);
});

check('a single socket is unchanged', () => {
  const s = liveSummary(client(2, 9));
  assert.equal(s.bps, 2e6);
  assert.equal(s.clients, 1);
});

check('every entry is accounted for as used', () => {
  // With the pairing holding lists, the leftover calculation has to flatten
  // them or every extra socket looks unmatched.
  const objects = [{ id: 'w1', name: 'a', port: 100 }];
  const entries = [
    { name: 'a', id: 'x:1->y:100', stats: { send: { mbpsRate: 1 } } },
    { name: 'a', id: 'x:2->y:100', stats: { send: { mbpsRate: 1 } } },
  ];
  const r = joinLive(entries, objects);
  assert.equal(r.matched, 1, 'one object');
  assert.equal(r.unmatchedEntries.length, 0, 'and both sockets belong to it');
});

console.log('\nDIFFERENT STREAMS IS NOT A FAILED MATCH:');

check('no port overlap is reported as its own case', () => {
  // On SRT In not one of 61 live sockets shares a port with the 76 objects.
  // "Could not be matched" reads as a fault; there was never anything to
  // match.
  const proxy = readFileSync(new URL('../src/routes/nimbleProxy.js', import.meta.url), 'utf8');
  assert.ok(proxy.includes('const portOverlap ='));
  assert.ok(proxy.includes('portOverlap,'));
  const tabs = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');
  assert.ok(tabs.includes('live.portOverlap === 0'));
  assert.ok(tabs.includes("t('wo.liveElsewhere'"));
});

console.log('\nTHE KEY THAT PAIRS THE MOST WINS (v0.25.7):');

check('one accidental match no longer blocks a better key', () => {
  // It used to be the first key to match anything, on my theory that the order
  // encoded how strongly each identifies a stream. One stray name match then
  // stopped the port key from ever being tried — and the result looked exactly
  // like "these are different streams", which is what I concluded from it.
  const objects = [
    { id: 'w0', name: 'odd', port: 9999 },
    ...[17801, 17802, 17803, 17804].map((p, i) => ({ id: `w${i + 1}`, name: `feed${i}`, ip: '72.56.79.88', port: p })),
  ];
  const entries = [
    { name: 'odd', id: 'x:1->y:9999' },
    ...[17801, 17802, 17803, 17804].map(p => ({ id: `72.56.79.88:${p}`, stats: { recv: { mbpsRate: 6.5 } } })),
  ];
  const r = joinLive(entries, objects);
  assert.equal(r.strategy, 'localPort');
  assert.equal(r.matched, 5, 'the stray name match is included by the port key too');
  assert.deepEqual(r.candidates.filter(c => c.matched).map(c => `${c.key}:${c.matched}`), ['name:1', 'localPort:5']);
});

check('a tie is broken by order, so the stronger key still wins', () => {
  const objects = [{ id: 'w1', name: 'feed', port: 100 }];
  const entries = [{ name: 'feed', id: 'a:1->b:100', stats: { recv: { mbpsRate: 5 } } }];
  const r = joinLive(entries, objects);
  assert.equal(r.strategy, 'name', 'a name identifies; a port can be reused');
});

check('a caller socket is identified by the address it dialled', () => {
  // WMSPanel shows SRT stats for "72.56.79.88:17802" against an SRT In pull
  // object at that same address — no arrow, so the whole id is the peer.
  assert.equal(localPort('72.56.79.88:17802'), 'port:17802');
});


console.log('\nONE ANSWER TO "WHICH STREAM IS THIS" (v0.25.8):');

const collector = readFileSync(new URL('../src/services/statsCollector.js', import.meta.url), 'utf8');
const proxySrc2 = readFileSync(new URL('../src/routes/nimbleProxy.js', import.meta.url), 'utf8');
const tabsSrc3 = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');

check('the collector and the join share one identity function', () => {
  // There were two independent answers — the collector's, which keys the
  // series, and the join's, which fills the table — in different id spaces. So
  // the live columns could be right while the history stayed empty for ever,
  // which is precisely what happened.
  assert.ok(collector.includes('entryIdentity(so)'));
  assert.ok(proxySrc2.includes('entryIdentity(first)'));
});

check('identity excludes the socket pair, but not `id` in general', () => {
  // The first version threw away `id` outright, and some endpoints return a
  // perfectly stable id there — the collector suite caught it. What has to go
  // is the pair, whose source port changes on every reconnect.
  assert.equal(entryIdentity({ setting_id: 'abc' }), 'abc');
  assert.equal(entryIdentity({ id: 's1', msRTT: 18 }), 's1', 'a plain id is an identity');
  assert.equal(entryIdentity({ id: '31.28.6.149:60317->0.0.0.0:35001' }), 'port:35001');
  assert.equal(entryIdentity({ id: '72.56.79.88:17802' }), 'port:17802', 'a bare peer address too');
  assert.equal(entryIdentity({ name: 'feed' }), 'feed');
  assert.equal(entryIdentity({}), '');
});

check('the subject travels with the reading', () => {
  // Deriving it a second time in the browser is the mistake that made history
  // unreachable; now the endpoint that did the join says where the series is.
  assert.ok(proxySrc2.includes('subject: ident ?'));
  assert.ok(tabsSrc3.includes('subject: live?.live?.[o.id]?.subject'));
  assert.ok(!tabsSrc3.includes("`${kind === 'outgoing' ? 'srt-sender' : 'srt-receiver'}:${objectId}`"),
    'the browser must not build a subject of its own');
});

check('the series label comes from the endpoint that answered', () => {
  // Inferring it from the presence of a recv block would be guessing again.
  assert.ok(proxySrc2.includes('const SERIES_OF ='));
  assert.ok(proxySrc2.includes('__series'));
});

check('a row with no live socket says so instead of showing an empty chart', () => {
  assert.ok(tabsSrc3.includes("t('wo.histNoLive')"));
  assert.ok(tabsSrc3.includes('if (!subject) return undefined'), 'and asks for nothing');
});

console.log('\nTHE ENVELOPE (v0.25.10):');

const { entryList } = await import('../src/services/streamJoin.js');
const probe = JSON.parse(readFileSync(new URL('./fixtures/nimble-probe.json', import.meta.url), 'utf8'));

check('the SRT endpoints answer in an envelope the collector did not know', () => {
  // `{ SrtReceivers: [...] }` and `{ SrtSenders: [...] }`. The collector
  // matched a fixed list of key names — streams, sockets, stats, rules — so it
  // recorded NOTHING for SRT, while the same data reached the table through
  // the route's own, more forgiving, extraction. That is the whole of "the
  // server is reporting but this stream never appears".
  assert.deepEqual(probe.endpoints['/manage/srt_receiver_stats'].topLevel, ['SrtReceivers']);
  assert.deepEqual(probe.endpoints['/manage/srt_sender_stats'].topLevel, ['SrtSenders']);
  assert.equal(entryList({ SrtReceivers: [{ setting_id: 'a' }] }).length, 1);
  assert.equal(entryList({ SrtSenders: [{ setting_id: 'a' }] }).length, 1);
});

check('there is one extraction, used by both', () => {
  const collectorSrc2 = readFileSync(new URL('../src/services/statsCollector.js', import.meta.url), 'utf8');
  const proxySrc3 = readFileSync(new URL('../src/routes/nimbleProxy.js', import.meta.url), 'utf8');
  assert.ok(collectorSrc2.includes('entryList(d)'));
  assert.ok(proxySrc3.includes('entryList as asList'));
  assert.ok(!/^const asList = \(d\) => \{/m.test(proxySrc3), 'the route keeps no copy of its own');
});

check('a named list still wins over a stray array', () => {
  // republish answers { status: 'Ok', stats: [] } — `stats` is the data, and
  // taking the first array found would be luck rather than intent.
  assert.deepEqual(entryList({ status: 'Ok', stats: [] }), []);
  assert.equal(entryList({ rules: [{ a: 1 }], other: [{ b: 2 }] })[0].a, 1);
});

check('setting_id really is the WMSPanel object id', () => {
  // Established from the probe against the objects the panel holds — the thing
  // I asserted, then doubted, then had to be shown.
  const ids = probe.endpoints['/manage/srt_receiver_stats'].identifiers.map(x => x.setting_id);
  assert.ok(ids.every(id => /^[0-9a-f]{24}$/.test(id)), 'the same shape as a WMSPanel object id');
  assert.ok(ids.includes('6a18bf6773856944212d0d76'), 'and one the SRT In tab lists');
});

console.log('\nMEASURING INSTEAD OF SAMPLING (v0.25.11):');

const proxySrc4 = readFileSync(new URL('../src/routes/nimbleProxy.js', import.meta.url), 'utf8');
const statsSrc4 = readFileSync(new URL('../src/routes/stats.js', import.meta.url), 'utf8');


check('the join does pair the real data', () => {
  // Run against the probe's entries and the objects the panel holds, so a zero
  // in the panel cannot be blamed on the algorithm again.
  const probeIds = probe.endpoints['/manage/srt_receiver_stats'].identifiers
    .map(x => ({ setting_id: x.setting_id, id: x.id }));
  const objects = [
    { id: '6a18bf6773856944212d0d76', name: 'CCT_FEED4_EU_BACKUP', port: 18004 },
    { id: '6a18bf6973856944212d0d78', name: 'CCT_FEED5_EU_BACKUP', port: 18005 },
    { id: '6a1805ad73856944212d0793', name: 'unrelated', port: 21041 },
  ];
  const r = joinLive(probeIds, objects);
  assert.equal(r.strategy, 'setting_id');
  assert.equal(r.matched, 2);
});

console.log('\nA SUBJECT NEEDS A NAME:');

check('SRT subjects are resolved to their object names on read', () => {
  // "srt-receiver 6a1963109aac8647b52d1448" is not something to act on. The
  // collector cannot resolve it — one WMSPanel call per 10s sample would spend
  // the daily budget by lunchtime — so it happens here, cached, on a page a
  // person opened.
  assert.ok(statsSrc4.includes('async function decorateSrtLabels'));
  assert.ok(statsSrc4.includes('SRT_NAME_TTL_MS'));
  assert.ok(statsSrc4.includes("r.label = `${name} ·"), 'and the direction is kept');
});

check('a failed lookup leaves the list intact', () => {
  const from = statsSrc4.indexOf('async function srtNames');
  const body = statsSrc4.slice(from, statsSrc4.indexOf('async function decorateSrtLabels'));
  assert.ok(body.includes('} catch {'), 'a name is a nicety; its absence must not empty the list');
  assert.ok(body.includes('Promise.allSettled'), 'and one family failing does not lose the others');
});

console.log('\nWHICH MACHINE ANSWERED (v0.25.12):');

const proxySrc5 = readFileSync(new URL('../src/routes/nimbleProxy.js', import.meta.url), 'utf8');

check('investigation lives in tools, not in the response', () => {
  // It cost bytes on a request polled every ten seconds and put server
  // internals on a screen, for a question asked twice a year.
  for (const gone of ['diagnostics:', 'answeredBy:', 'responseShape', 'sampleEntryIds']) {
    assert.ok(!proxySrc5.includes(gone), `${gone} must not be in the live response`);
  }
  const tool = readFileSync(new URL('../tools/join-report.mjs', import.meta.url), 'utf8');
  assert.ok(tool.includes('idOverlap:') && tool.includes('answeredBy:'), 'and it is all still available');
});

check('the report measures sets, never samples', () => {
  // Two five-entry samples failing to overlap is what sent this down a wrong
  // path for several rounds. Counting the sets answers it exactly.
  const tool = readFileSync(new URL('../tools/join-report.mjs', import.meta.url), 'utf8');
  assert.ok(tool.includes('settingIds: nIds.size'));
  assert.ok(tool.includes('idOverlap:') && tool.includes('portOverlap:'));
  assert.ok(tool.includes('overlappingIds:'), 'and names which ones, so a zero can be checked');
});

check('the report still names the machine that answered', () => {
  // Two disjoint socket sets from one endpoint can only mean two Nimble
  // instances, and that is the first thing to rule out.
  const tool = readFileSync(new URL('../tools/join-report.mjs', import.meta.url), 'utf8');
  assert.ok(tool.includes('cores:') && tool.includes('gpu:'));
  assert.ok(tool.includes('maskIp'), 'with addresses reduced before they are printed');
});

console.log('\nTWO MACHINES, ONE SERVER RECORD (v0.25.14):');

const proxy6 = readFileSync(new URL('../src/routes/nimbleProxy.js', import.meta.url), 'utf8');
const tabs6 = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');

check('the data already showed which machine is which', () => {
  // Every subject the panel collects appears in the first dump and none in the
  // probe run on the box: the probe ran on the machine WMSPanel calls "Сердце
  // Пальмиры", and the panel's native URL reaches a different one.
  const first = new Set(real.map(e => e.setting_id));
  const probed = new Set(probe.endpoints['/manage/srt_receiver_stats'].identifiers.map(x => x.setting_id));
  assert.equal([...first].filter(id => probed.has(id)).length, 0, 'the two captures share nothing');
  // And the probe's ports are the ones the SRT In tab lists.
  const probePorts = new Set(probe.endpoints['/manage/srt_receiver_stats'].identifiers
    .map(x => x.id.split(':').pop()));
  for (const p of ['18004', '18005', '18006']) assert.ok(probePorts.has(p), `port ${p}`);
});

check('the server-wide check counts ids, not ports', () => {
  // Its first version counted ports and stayed silent on the very case it was
  // written for: the machine being reached had sockets on 35001-35005, and
  // this server's SRT Out objects use those same numbers. Ports repeat across
  // machines — that is what makes them a weak key — and a WMSPanel object id
  // belongs to exactly one server.
  assert.ok(proxy6.includes('async function allObjectIds'));
  assert.ok(!proxy6.includes('allObjectPorts'), 'the port version is gone');
  const from = proxy6.indexOf('async function serverWideOverlap');
  const body = proxy6.slice(from, from + 700);
  assert.ok(body.includes('setting_id'), 'and it compares setting_id against object ids');
});

check('a build that reports no setting_id gets no verdict', () => {
  // Better unanswered than answered wrongly: with nothing to compare, an
  // overlap of zero would accuse a correctly wired server.
  const from = proxy6.indexOf('async function serverWideOverlap');
  assert.ok(proxy6.slice(from, from + 700).includes('if (!socketIds.size) return null'));
});

check('the message names the address actually being polled', () => {
  // A server record can carry several addresses — the operator had no way to
  // know which one the native calls use, and in this case it was one WMSPanel
  // had assigned rather than the machine's own.
  assert.ok(proxy6.includes('nativeHost:'));
  assert.ok(tabs6.includes('host: live.nativeHost'));
});

check('no overlap anywhere on the server is reported as a wiring fault', () => {
  // Nothing in common on ONE tab is normal — those objects live elsewhere.
  // Nothing in common across the WHOLE server is a different claim, and it is
  // the one that cost this investigation a dozen rounds unstated.
  assert.ok(proxy6.includes('serverOverlap:'));
  assert.ok(proxy6.includes('async function serverWideOverlap'));
  assert.ok(tabs6.includes('live.serverOverlap === 0'));
  assert.ok(tabs6.includes("t('wo.wrongMachine',"));
});

check('the server-wide check is cached and cannot break the tab', () => {
  // It asks three more WMSPanel lists; on a poll that would be a budget
  // problem, and a failure must not empty a table.
  assert.ok(proxy6.includes('OBJECT_ID_TTL_MS'));
  // Bounded by the function itself rather than a character count, which was
  // just short enough to miss the catch.
  const from = proxy6.indexOf('async function serverWideOverlap');
  const body = proxy6.slice(from, proxy6.indexOf('\nconst SERIES_OF', from));
  assert.ok(body.includes('catch { return null; }'));
});

console.log('\nNATIVE READS GO THROUGH THE AGENT (v0.26.0):');

const clientSrc = readFileSync(new URL('../src/services/nimbleClient.js', import.meta.url), 'utf8');
const agentSrc2 = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');

check('the panel asks the agent before dialling the server', () => {
  // The direct call predates the reverse transport and is the last place the
  // panel opens a connection TO a server — which simply cannot work for a
  // server on a studio LAN behind NAT.
  assert.ok(clientSrc.includes('function agentIsLive'));
  const preferAt = clientSrc.indexOf('agentIsLive(server)');
  const directAt = clientSrc.indexOf('const url = buildUrl(server, path, extraQuery);', preferAt);
  assert.ok(preferAt > 0 && preferAt < directAt, 'the agent is tried first');
});

check('a silent agent is not waited on', () => {
  // A poll is due every 25s; waiting on a task nothing will claim is worse
  // than a direct attempt that fails quickly.
  assert.ok(clientSrc.includes('90_000'));
  assert.ok(clientSrc.includes("!a?.enabled || !a?.lastContactAt"));
});

check('writes stay direct', () => {
  // Control is rarer and watched: a long-poll cycle between an operator and
  // the change they are waiting for is a bad trade.
  assert.ok(clientSrc.includes("method === 'GET' && !body && agentIsLive(server)"));
});

check('the agent answers only for its own machine', () => {
  // It fetches loopback. A mismatched server record cost this project a dozen
  // releases; through the agent it is impossible by construction.
  assert.ok(agentSrc2.includes("'http://127.0.0.1:8082'"));
  assert.ok(agentSrc2.includes("async 'POST /nimble'"));
});

check('the proxy forwards only Nimble management reads', () => {
  // A proxy that forwards anything is one somebody eventually points
  // elsewhere, whatever authenticated it.
  const re = /^\/manage\/[A-Za-z0-9_/-]*$/;
  assert.equal(re.test('/manage/srt_receiver_stats'), true);
  assert.equal(re.test('/manage/../../etc/passwd'), false);
  assert.equal(re.test('http://elsewhere/x'), false);
  assert.equal(re.test('/admin'), false);
  assert.ok(agentSrc2.includes('only /manage/... paths are allowed'));
});

check('there is no import cycle between the client and the bus', () => {
  const bus = readFileSync(new URL('../src/services/agentBus.js', import.meta.url), 'utf8');
  assert.ok(!/from '\.\/nimbleClient/.test(bus), 'the bus must not import back');
});

console.log('\nWALKING THE PIPELINE (v0.26.1):');

const collectorSrc3 = readFileSync(new URL('../src/services/statsCollector.js', import.meta.url), 'utf8');
const statsTab = readFileSync(new URL('../../frontend/src/pages/StatsTab.jsx', import.meta.url), 'utf8');

check('a disconnected socket really does hold only a retry counter', () => {
  // Which means "60 subjects collected" can be entirely true and entirely
  // useless at the same time, and the charts are then empty for a reason the
  // health line called fine.
  const conn = real.find(e => e.stats?.recv?.mbpsRate > 0);
  const down = real.find(e => e.state === 'disconnected');
  assert.equal(Object.keys(flattenNumbers(down)).length, 1);
  assert.deepEqual(Object.keys(flattenNumbers(down)), ['retryCount']);
  assert.ok(Object.keys(flattenNumbers(conn)).length > 15, 'a connected one carries the rest');
});

check('the health report separates subjects from subjects with data', () => {
  assert.ok(collectorSrc3.includes('const withData ='));
  assert.ok(statsTab.includes("t('stats.hNoData')"), 'and says so when none of them has any');
});

check('there is a tool that walks the links in order', () => {
  // Six links between a socket and a point on a chart, and a break in any of
  // them looks the same from the browser: an empty graph.
  const tool = readFileSync(new URL('../tools/pipeline-check.mjs', import.meta.url), 'utf8');
  for (const step of ['1. SETTINGS AND TRANSPORT', '2. WHAT NIMBLE RETURNS', '3. IDENTITY',
                      '4. WHAT IS STORED', '5. LIVE ENTRIES vs STORED SUBJECTS',
                      '6. A CARRYING SOCKET, END TO END']) {
    assert.ok(tool.includes(step), step);
  }
  assert.ok(tool.includes('VERDICT'), 'and it names the link that is short');
});

console.log('\nA METRIC KEY MUST BE STORABLE (v0.26.4):');

await acheck('a dotted key makes the whole sample fail to validate', async () => {
  // MongoDB forbids a dot in a map key. `stats.link.rtt` therefore killed the
  // write — and only sockets carrying nothing survived, because a disconnected
  // entry flattens to `retryCount` alone and has no dot in it. Every socket
  // worth charting was discarded, silently, for as long as this existed.
  const { StatSample } = await import('../src/models/StatSample.js');
  const mk = (metrics) => new StatSample({
    serverId: 'a'.repeat(24), subject: 's', group: 'srt', label: 'l', ts: new Date(), metrics,
  });
  let dottedFailed = false;
  try { await mk({ retryCount: 1, 'stats.link.rtt': 9.8 }).validate(); }
  catch { dottedFailed = true; }
  assert.ok(dottedFailed, 'a dot in a key is not storable');
  await mk({ retryCount: 1, stats_link_rtt: 9.8 }).validate();
});

check('every key the flattener produces is storable', () => {
  const conn = real.find(e => e.stats?.recv?.mbpsRate > 0);
  const keys = Object.keys(flattenNumbers(conn));
  assert.equal(keys.length, 18);
  assert.ok(!keys.some(k => k.includes('.')));
  assert.ok(keys.includes('stats_recv_mbpsRate') && keys.includes('stats_link_rtt'));
});

check('the reader asks for the names that are actually stored', () => {
  const tabs = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');
  assert.ok(tabs.includes("'stats_recv_mbpsRate'"));
  assert.ok(!tabs.includes("'stats.recv.mbpsRate'"), 'the dotted names would silently match nothing');
});

check('the diagnostic follows a socket carrying media, not merely bytes', () => {
  // An idle SRT socket still costs a few tens of kbit/s in handshake traffic.
  // Picking one meant following a stream with nothing to draw and then
  // reporting on it as though it had.
  const diag = readFileSync(new URL('../../tools/nnm-diag.mjs', import.meta.url), 'utf8');
  assert.ok(diag.includes('const NO_MEDIA_BPS = 200_000'));
  assert.ok(diag.includes('v.bps > NO_MEDIA_BPS'));
});

check('it will not count a counter and call it a rate', () => {
  // Falling back to "whatever is there" is how it reported "end to end is
  // intact" about a subject whose only metric was retryCount.
  const diag = readFileSync(new URL('../../tools/nnm-diag.mjs', import.meta.url), 'utf8');
  assert.ok(diag.includes('const wanted = rateKeys.slice(0, 4)'));
  assert.ok(!diag.includes('rateKeys.length ? rateKeys : held'), 'the fallback is gone');
  assert.ok(diag.includes('holds no rate metric at all'), 'and it says so instead');
});

check('the diagnostic asks what a subject holds, rather than assuming', () => {
  // It hardcoded the dotted names and then reported "no rate in any point"
  // against a panel that was storing rates perfectly well. A diagnostic that
  // can be wrong about the thing it diagnoses is worse than none.
  const diag = readFileSync(new URL('../../tools/nnm-diag.mjs', import.meta.url), 'utf8');
  assert.ok(!diag.includes('stats.recv.mbpsRate'), 'no hardcoded metric names');
  assert.ok(diag.includes('const held ='));
  assert.ok(diag.includes('/rate|bitrate|bandwidth/i'));
  // A configured ceiling is not a reading.
  const pick = (ks) => ks.filter(k => /rate|bitrate|bandwidth/i.test(k) && !/max/i.test(k));
  assert.deepEqual(pick(['retryCount', 'stats_link_mbpsMaxBandwidth', 'stats_recv_mbpsRate']),
    ['stats_recv_mbpsRate']);
});

console.log('\nTHE SUMMARY (iter16 m3):');

const statsRoute3 = readFileSync(new URL('../src/routes/stats.js', import.meta.url), 'utf8');
const statsTab2 = readFileSync(new URL('../../frontend/src/pages/StatsTab.jsx', import.meta.url), 'utf8');

check('many subjects come back in one request', () => {
  // Per subject would be forty round trips on open and forty more per refresh,
  // and the page would paint in forty jerks.
  assert.ok(statsRoute3.includes("statsRouter.get('/:serverId/multi'"));
  assert.ok(statsTab2.includes('/multi'));
  // Counting the calls, not pattern-matching around a map: the subject list IS
  // built with a map, inside the single request, and the first version of this
  // check flagged that.
  const summaryFn = statsTab2.slice(statsTab2.indexOf('const loadSummary'),
    statsTab2.indexOf('useEffect(() => { loadSummary(); })'));
  assert.equal([...summaryFn.matchAll(/\bapi\(/g)].length, 1, 'exactly one request for the whole summary');
});

check('one request cannot become a hundred aggregations', () => {
  assert.ok(statsRoute3.includes('.slice(0, 60)'));
  assert.ok(statsRoute3.includes('targetPoints: 120'), 'and small charts get fewer points');
});

check('labels reach the response', () => {
  // decorateSrtLabels writes onto the objects it is given; a mapped copy takes
  // the labels with it and the cards show raw ids.
  assert.ok(statsRoute3.includes('for (const o of out) o.group'));
  assert.ok(!/decorateSrtLabels\(serverId, out\.map/.test(statsRoute3));
});

check('the rate metric is discovered, not named', () => {
  // Naming it has cost a release twice in this epic.
  assert.ok(statsTab2.includes('const rateKeyOf'));
  assert.ok(statsTab2.includes('/rate|bitrate|bandwidth/i'));
  assert.ok(statsTab2.includes('!/max/i.test(k)'), 'a configured ceiling is not a reading');
});

check('idle subjects are counted, not silently dropped', () => {
  // Half of a server's seventy SRT subjects are disconnected sockets holding a
  // retry counter. Drawing them all buries the interesting ones; hiding them
  // without saying they exist is worse.
  assert.ok(statsTab2.includes("t('stats.sumShowIdle'"));
  assert.ok(statsTab2.includes("t('stats.sumCarrying'"));
});

check('the busiest are drawn first', () => {
  assert.ok(statsTab2.includes('rows.sort((a, b) => (b.bps ?? -1) - (a.bps ?? -1))'));
});

console.log('\nCONTROL AND COLLECTION ARE DIFFERENT THINGS (iter16 m4):');

const detail = readFileSync(new URL('../../frontend/src/pages/ServerDetailPage.jsx', import.meta.url), 'utf8');
const proxy7 = readFileSync(new URL('../src/routes/nimbleProxy.js', import.meta.url), 'utf8');
const tab3 = readFileSync(new URL('../../frontend/src/pages/StatsTab.jsx', import.meta.url), 'utf8');

check('the notice appears only where something is withheld', () => {
  // It used to sit above every tab in WMSPanel mode, including the ones where
  // nothing is disabled — so it read as the explanation for whatever looked
  // wrong on screen, and for a long stretch of this epic it was taken for
  // exactly that.
  assert.ok(detail.includes('const hiddenNative ='));
  assert.ok(detail.includes('wms && hiddenNative.length > 0'));
});

check('it names the tabs rather than describing them', () => {
  // "native sections are disabled" leaves the reader to work out whether the
  // thing they are missing is one of them.
  assert.ok(detail.includes("t('server.bannerWms', { tabs: hiddenNative.join(', ') })"));
  assert.ok(detail.includes(".map(x => x.label)"));
});

check('and it says collection is unaffected', () => {
  assert.ok(detail.includes("t('server.bannerWmsStats')"));
  assert.ok(tab3.includes("t('stats.healthPlane')"), 'again where the collector reports on itself');
});

check('the guard says which half it is refusing', () => {
  // "the native API is disabled" was true of control and false of everything
  // else, and it reached the browser for reads too until v0.24.1.
  assert.ok(proxy7.includes('Native Nimble control is off'));
  assert.ok(proxy7.includes('Statistics are unaffected'));
  assert.ok(!proxy7.includes('Native Nimble API is disabled'));
});

console.log('\nEXISTING IS A MEASUREMENT (v0.27.3):');

const collector4 = readFileSync(new URL('../src/services/statsCollector.js', import.meta.url), 'utf8');
const tabs4 = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');

check('a socket with nothing numeric still gets a series', () => {
  // Two sockets on this fleet reported no stats block and not even a retry
  // counter, so `add` — which skips an empty metric set — gave them no series
  // at all. The panel could see them and the history said "never appeared":
  // both true, and useless together. Same two ids in four consecutive runs.
  const withPresence = (e) => {
    const m = flattenNumbers(e);
    m.present = 1;
    const st = String(e.state ?? '').toLowerCase();
    if (st) m.connected = st === 'connected' ? 1 : 0;
    return m;
  };
  assert.equal(Object.keys(flattenNumbers({ setting_id: 'C', state: 'connecting' })).length, 0);
  assert.deepEqual(withPresence({ setting_id: 'C', state: 'connecting' }), { present: 1, connected: 0 });
  assert.ok(collector4.includes('metrics.present = 1'));
});

check('presence does not disturb a socket that has readings', () => {
  const conn = real.find(e => e.stats?.recv?.mbpsRate > 0);
  const m = flattenNumbers(conn);
  m.present = 1;
  assert.equal(m.stats_recv_mbpsRate, conn.stats.recv.mbpsRate, 'the rate is untouched');
  assert.equal(m.present, 1);
});

check('"no series" and "a series with nothing in it" are different sentences', () => {
  // The operator acts on them differently: one means the collector never saw
  // the socket, the other that it is watched and has carried nothing.
  assert.ok(tabs4.includes("t('wo.histNeverSeen')"));
  assert.ok(tabs4.includes("t('wo.histPresentOnly'"));
});

console.log('\nEVERY SRT COLUMN WMSPANEL SHOWS (v0.28.0):');

const tabs5 = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');
const plotSrc2 = readFileSync(new URL('../../frontend/src/components/Plot.jsx', import.meta.url), 'utf8');

check('all seventeen were already in the series', () => {
  // The gap was never data. Three charts out of eighteen metrics is a display
  // decision, and the collector has stored the lot since it was fixed.
  const stored = Object.keys(flattenNumbers(real.find(e => e.stats?.recv?.mbpsRate > 0)));
  for (const k of ['stats_time', 'stats_window_flow', 'stats_window_congestion', 'stats_window_flight',
                   'stats_link_rtt', 'stats_link_mbpsBandwidth', 'stats_link_mbpsMaxBandwidth',
                   'stats_recv_packetsReceived', 'stats_recv_packetsReceivedRetransmitted',
                   'stats_recv_packetsLost', 'stats_recv_packetsDropped', 'stats_recv_packetsBelated',
                   'stats_recv_NAKsSent', 'stats_recv_bytesReceived', 'stats_recv_bytesLost',
                   'stats_recv_bytesDropped', 'stats_recv_mbpsRate']) {
    assert.ok(stored.includes(k), k);
  }
});

check('the tiles cover them, grouped by question', () => {
  // A tile mixing lost with belated answers "how is the link" once, where two
  // tiles would ask it twice.
  const covered = [...tabs5.matchAll(/'(stats_[a-z_A-Z]+|retryCount)'/g)].map(m => m[1]);
  for (const k of ['stats_recv_mbpsRate', 'stats_link_rtt', 'stats_recv_packetsLost',
                   'stats_recv_NAKsSent', 'stats_window_flight', 'stats_recv_bytesDropped']) {
    assert.ok(covered.includes(k), `${k} is drawn`);
  }
});

check('one request feeds every tile', () => {
  // Eight requests would be eight aggregations over the same documents.
  assert.ok(tabs5.includes('const METRICS = [...new Set(HIST_TILES.flatMap(x => x.metrics))]'));
});

check('a tile with no readings is not drawn', () => {
  // A receiver has no send counters and vice versa; empty axes are noise.
  assert.ok(tabs5.includes('const liveTiles = HIST_TILES.filter'));
  assert.ok(tabs5.includes('Number.isFinite(p.v[i])'));
});

check('a chart says what is under the cursor', () => {
  // A reading without its moment is half a reading.
  assert.ok(plotSrc2.includes('setCursor:'));
  assert.ok(plotSrc2.includes('at.toLocaleTimeString()'));
  assert.ok(plotSrc2.includes('formatValue(v, unit)'));
  assert.ok(plotSrc2.includes("tip.style.display = 'none'"), 'and hides when the cursor leaves');
  assert.ok(plotSrc2.includes('u.over.clientWidth'), 'flipping at the edge so it stays inside');
});

console.log('\nUNITS (v0.28.1):');

const timeChart = readFileSync(new URL('../../frontend/src/components/TimeChart.jsx', import.meta.url), 'utf8');
const fmt = new Function(
  `${timeChart.slice(timeChart.indexOf('export function formatValue'), timeChart.indexOf('export default function TimeChart'))
    .replace('export function', 'function')}; return formatValue;`)();

check('every unit these charts use is formatted, not left bare', () => {
  // Only `bps` was handled, so RTT read "9.81" and a byte total read
  // "29,000,000,000" — figures whose unit the reader has to guess.
  assert.equal(fmt(9.811, 'ms'), '9.81 ms');
  assert.equal(fmt(81.3, 'Mbps'), '81.3 Mbps');
  assert.equal(fmt(6435, 'pkt'), '6,435 pkt');
  assert.equal(fmt(29e9, 'B'), '29.00 GB');
  assert.equal(fmt(0.03, '%'), '0.03%');
  assert.equal(fmt(6.2e6, 'bps'), '6.20 Mbps', 'the original behaviour is unchanged');
});

check('a large count stays legible', () => {
  // 22 890 894 packets is a number nobody reads; 22.89M is.
  assert.equal(fmt(22890894, 'pkt'), '22.89M pkt');
  assert.equal(fmt(8.3e6, 'B'), '8.3 MB');
});

check('no unit still means no unit', () => {
  assert.equal(fmt(8192, ''), '8,192');
  assert.equal(fmt(null, 'ms'), '—');
});

check('SRT windows are measured in packets, and rates arrive in megabits', () => {
  // Converting Nimble's Mbps to bits would invite exactly the confusion this
  // change is fixing.
  const tabs = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');
  assert.ok(/key: 'window', unit: 'pkt'/.test(tabs));
  assert.ok(/key: 'rate', unit: 'Mbps'/.test(tabs));
});

check('a counter that only climbs is labelled as one', () => {
  // A rising line means "it has happened", not "it is happening". The slope is
  // the reading; the height is not.
  const tabs = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');
  assert.ok(tabs.includes('cumulative: true'));
  assert.ok(tabs.includes("t('wo.cumulative')") && tabs.includes("t('wo.cumulativeHint')"));
});

console.log('\nAXIS LABELS FIT (v0.28.2):');

const plot3 = readFileSync(new URL('../../frontend/src/components/Plot.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../frontend/src/styles.css', import.meta.url), 'utf8');

check('the axis gutter is measured, not fixed', () => {
  // A fixed 58px fitted bare numbers and stopped fitting the moment the labels
  // carried units. A clipped label reads as a DIFFERENT number rather than as
  // a truncated one — "06 Mbps" where "0.06 Mbps" was drawn — which is worse
  // than no label at all.
  assert.ok(plot3.includes('size: (u, values)'));
  assert.ok(plot3.includes('measureText'));
  assert.ok(!/size: 58/.test(plot3), 'the constant is gone');
});

check('the sizing follows the labels and stays bounded', () => {
  const size = (vals, measure = (x) => x.length * 6.2) =>
    (vals.length ? Math.min(120, Math.ceil(Math.max(...vals.map(measure))) + 14) : 44);
  assert.ok(size(['0.06 Mbps']) > 58, 'the case that was clipped now fits');
  assert.ok(size(['22.89M pkt']) > size(['0%', '100%']), 'wider labels get a wider gutter');
  assert.equal(size([]), 44, 'and no labels means no measurement to make');
  assert.ok(size(['x'.repeat(200)]) <= 120, 'one enormous label cannot eat the chart');
});

check('a chart modal is wide but never wider than the screen', () => {
  assert.ok(css.includes('.modal.w-chart'));
  assert.ok(css.includes('min(1240px, calc(100vw - 48px))'));
  // The existing sizes were unbounded, which on a laptop ran off the side.
  assert.ok(css.includes('min(760px, calc(100vw - 48px))'));
});

console.log('\nWHEN NIMBLE IS NOT ON LOOPBACK (v0.45.0):');

const agentSrc9 = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
const clientSrc9 = readFileSync(new URL('../src/services/nimbleClient.js', import.meta.url), 'utf8');

check('the failure names the addresses it tried', () => {
  // "fetch failed" names neither the address nor the reason, so a Nimble that
  // is down and one listening on a different interface look identical.
  assert.ok(agentSrc9.includes('could not reach Nimble from this server — tried'));
  assert.ok(agentSrc9.includes("e?.cause?.code || e?.name"), 'with the errno, not just a message');
});

check('loopback is tried first and the known address second', () => {
  // Loopback is what makes "which machine answered" a non-question. The
  // fallback is still this machine — the agent runs on it — so it cannot
  // reach a different Nimble.
  assert.ok(agentSrc9.includes('const bases = [NIMBLE_URL];'));
  assert.ok(agentSrc9.includes('if (task?.baseUrl && !bases.includes(task.baseUrl))'));
  assert.ok(clientSrc9.includes('baseUrl: buildUrl(server'), 'and the panel supplies it');
});

check('an answer ends the search, even a bad one', () => {
  // Trying a second address after a server has already replied is asking a
  // question that was answered.
  const at = agentSrc9.indexOf('for (const base of bases)');
  const body = agentSrc9.slice(at, agentSrc9.indexOf('throw new Error(`could not reach', at));
  assert.ok(body.includes('if (!res.ok) throw new Error('), 'an HTTP error is the answer');
  assert.ok(body.includes('continue;'), 'only an unreachable address moves on');
});

check('the fallback keeps the credential', () => {
  // The token travels in the query string the panel builds, not in the base —
  // a base carrying it would put it in the fallback path twice or not at all.
  const at = clientSrc9.indexOf('async function viaAgent');
  const body = clientSrc9.slice(at, at + 700);
  assert.ok(body.includes('authQuery(server.token)'));
  assert.ok(body.includes("[extraQuery, auth].filter(Boolean).join('&')"));
});

console.log('\nRTMP TABS AND TAGS (v0.46.0):');

const rp = readFileSync(new URL('../../frontend/src/pages/RepublishTab.jsx', import.meta.url), 'utf8');
const wo = readFileSync(new URL('../../frontend/src/pages/WmsObjectsTabs.jsx', import.meta.url), 'utf8');
const tags = readFileSync(new URL('../../frontend/src/components/StreamTags.jsx', import.meta.url), 'utf8');
const css5 = readFileSync(new URL('../../frontend/src/styles.css', import.meta.url), 'utf8');

check('both RTMP tabs filter, as the SRT tabs do', () => {
  // It was the only difference in how the two families were treated, and a
  // list this long is unusable without one.
  assert.ok(rp.includes("const [filter, setFilter]"));
  assert.ok(wo.includes("t('wo.filterPlaceholder')"));
  // Matched on what someone knows about a rule when hunting for it.
  assert.ok(rp.includes('rule.src_app, rule.src_strm, rule.dest_addr'));
  assert.ok(wo.includes('[o.application, o.stream, o.url, o.description]'));
});

check('the name leads, not the id', () => {
  // The id identifies a rule to the system and never to the person looking
  // for it, and it was the first column.
  const head = rp.slice(rp.indexOf('<thead>'), rp.indexOf('</thead>'));
  assert.ok(head.indexOf('rp.sourceAppStream') < head.indexOf('rp.id') || !head.includes('rp.id'));
});

check('a push rule can be stopped from its row', () => {
  // Stopping one was a checkbox called "Paused" inside the edit form: three
  // clicks and a save, for something done in a hurry.
  assert.ok(rp.includes('const savePaused = async (rule, paused)'));
  // The words became glyphs in v0.46.1; what matters is that the row offers
  // both states, not how they are spelled.
  assert.ok(rp.includes("action={rule.paused ? 'start' : 'stop'}"));
  // A whole-object PUT: rebuilding the rule from the row would drop whatever
  // the row does not display.
  assert.ok(rp.includes('body: { ...rule, paused }'));
});

check('tag chips are sized for a pointer', () => {
  // They are the primary filter on every object list and were small enough to
  // read as decoration.
  assert.match(css5, /\.tagchip \{[^}]*font-size:12\.5px/);
});

check('a tag can be hidden without being unassigned', () => {
  // A vocabulary grows over a season and most of it is last month's. Deleting
  // would take the tag off the streams; hiding is what was actually wanted.
  assert.ok(tags.includes("sessionStorage.getItem('nnm.tagsHidden'"));
  assert.ok(tags.includes('const visible = st.catalog.filter(x => !hidden.has(x))'));
  assert.ok(tags.includes("t('tag.hiddenCount'"), 'and the bar says how many are out of sight');
});

check('deleting a tag says how many streams carry it', () => {
  // Removing it from every stream on a tab is a decision taken blind
  // otherwise.
  assert.ok(tags.includes('const countFor = (tag) =>'));
  assert.ok(tags.includes('st.deleteTagEverywhere(tag)'), 'and calls the helper that exists');
  assert.ok(!tags.includes('removeTagEverywhere'), 'a guessed name made the button vanish rather than fail');
});

console.log('\nNAMES AND GLYPHS (v0.46.1):');

const rp2 = readFileSync(new URL('../../frontend/src/pages/RepublishTab.jsx', import.meta.url), 'utf8');
const icon = readFileSync(new URL('../../frontend/src/components/IconButton.jsx', import.meta.url), 'utf8');
const css6 = readFileSync(new URL('../../frontend/src/styles.css', import.meta.url), 'utf8');

check('a rule shows the name it was given', () => {
  // The description was stored and editable and never displayed, so a table of
  // eighty-three rules identified them all by app/stream alone.
  assert.ok(rp2.includes('rule.description ? ('));
  assert.ok(rp2.includes('<b style={{ fontSize: 13 }}>{rule.description}</b>'));
  // And the path stays, below it: it is what the system knows the rule by.
  const at = rp2.indexOf('{rule.description}</b>');
  assert.ok(rp2.slice(at, at + 260).includes('{rule.src_app}/{rule.src_strm'));
});

check('a rule without a name falls back to its path', () => {
  // Otherwise the column would be empty for every rule nobody described.
  const at = rp2.indexOf('rule.description ? (');
  assert.ok(rp2.slice(at, at + 700).includes(') : ('), 'there is an else');
});

check('an icon keeps its word', () => {
  // An icon alone is a guess until it has been learned, and some of these stop
  // a broadcast.
  assert.ok(icon.includes('title={title || word}'));
  assert.ok(icon.includes('aria-label={word}'));
  assert.ok(icon.includes('<span className="lbl">{word}</span>'));
  assert.match(css6, /button\.icon \.lbl[^}]*clip:/, 'the word is off-screen, not display:none');
});

check('the glyphs are defined once', () => {
  // Five actions across several tabs; spelling them per call site is how two
  // tabs end up meaning different things by the same symbol.
  assert.ok(icon.includes('const GLYPH = {'));
  for (const a of ['start', 'stop', 'restart', 'edit', 'remove']) {
    assert.ok(new RegExp(`${a}:`).test(icon), a);
  }
  assert.ok(icon.includes("GLYPH[action] || '·'"), 'and an unknown action is visible, not blank');
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall stream-join checks passed');
process.exit(fail ? 1 : 0);
