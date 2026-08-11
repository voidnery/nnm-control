// The arbiter, iter20 m5.
//
// This is the part Softvelum leave to the customer: their documented answer to
// balancing is "write an arbiter". The rules that matter are not about picking
// a winner — that is arithmetic — but about the cases where picking is
// impossible or wrong, and about saying so instead of picking anyway.
import assert from 'node:assert/strict';
import { chooseEdge, candidates, viewerUrl, routingTable } from '../src/services/arbiter.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

// `routes` is what the edge is configured to serve; `channels` is what it
// happens to be streaming this second. Only the first decides eligibility —
// see the deadlock described in candidates().
const E = (name, over = {}) => ({
  name, host: `10.0.0.${name.length}`, httpPort: 8081, weight: 100,
  enabled: true, healthy: true, routes: ['test2'], channels: [], ...over,
});
const FRA = E('fra', { lat: 50.11, lon: 8.68, connections: 400 });
const AMS = E('ams', { lat: 52.37, lon: 4.90, connections: 100 });
const MSK = E('msk', { lat: 55.75, lon: 37.62, connections: 900 });
const ALL = [FRA, AMS, MSK];

// Berlin is 423 km from Frankfurt and 576 km from Amsterdam — checked against
// the function rather than assumed. The first version of the test below
// expected Amsterdam, on nothing but a hunch about the map, and the code was
// right. A fixture whose expected answer cannot be verified independently is a
// coin toss with extra steps.
const BERLIN = { lat: 52.52, lon: 13.40 };
const LISBON = { lat: 38.72, lon: -9.14 };

console.log('\nWHO IS EVEN A CANDIDATE:');

check('an idle edge with a route is a candidate', () => {
  // The bug this replaces: requiring the edge to be *already streaming* the
  // channel deadlocked the whole arbiter. A re-streaming route pulls nothing
  // until a viewer asks, so no viewer ever got sent and the edge never woke.
  const idle = E('idle', { channels: [] });
  assert.equal(candidates([idle], { channel: 'test2' }).length, 1);
});

check('an edge with no route for the channel is not a candidate', () => {
  const other = E('other', { routes: ['something-else'] });
  assert.deepEqual(candidates([FRA, other], { channel: 'test2' }).map(e => e.name), ['fra']);
});

check('an edge whose routes were not read is still a candidate', () => {
  // `undefined` means the panel could not ask, not that the edge has none.
  // Excluding it would shrink the network every time a poll failed.
  const unchecked = E('unchecked', { routes: undefined });
  assert.equal(candidates([unchecked], { channel: 'test2' }).length, 1);
});

check('disabled and unhealthy edges are out', () => {
  assert.equal(candidates([E('a', { enabled: false }), E('b', { healthy: false })]).length, 0);
});

console.log('\nCHOOSING:');

check('nearest picks by great-circle distance and shows the runners-up', () => {
  const r = chooseEdge(ALL, { policy: 'nearest', viewer: BERLIN, channel: 'test2' });
  assert.equal(r.edge.name, 'fra', 'Berlin is 423 km from Frankfurt, 576 from Amsterdam');
  assert.equal(r.reason, 'nearest');
  assert.ok(Math.abs(r.distanceKm - 423) < 15, `got ${r.distanceKm} km`);
  assert.ok(r.runnersUp.length >= 1, 'the comparison is not shown');
});

check('distance beats load — nearest means nearest', () => {
  // Amsterdam is emptier and Moscow is loaded, and neither matters under this
  // policy. A "nearest" that drifts towards the least busy box is a different
  // policy wearing the same name.
  const r = chooseEdge(ALL, { policy: 'nearest', viewer: LISBON, channel: 'test2' });
  assert.equal(r.edge.name, 'ams', 'Lisbon is nearer Amsterdam than Frankfurt');
});

check('least-loaded picks the emptiest', () => {
  const r = chooseEdge(ALL, { policy: 'least-loaded', channel: 'test2' });
  assert.equal(r.edge.name, 'ams');
  assert.equal(r.connections, 100);
});

check('failover takes the operator\'s own order', () => {
  const r = chooseEdge(ALL, { policy: 'failover', channel: 'test2' });
  assert.equal(r.edge.name, 'fra');
  const r2 = chooseEdge([{ ...FRA, healthy: false }, AMS, MSK], { policy: 'failover', channel: 'test2' });
  assert.equal(r2.edge.name, 'ams', 'a dead first choice is skipped, not returned');
});

console.log('\nWHEN CHOOSING IS IMPOSSIBLE, IT SAYS SO:');

check('an unlocated viewer falls back and admits it', () => {
  // "nearest" that quietly becomes "whichever" is how a delivery network
  // develops a favourite continent nobody chose.
  const r = chooseEdge(ALL, { policy: 'nearest', viewer: null, channel: 'test2' });
  assert.ok(r.edge, 'no edge was returned at all');
  assert.equal(r.reason, 'viewer-unlocated');
  assert.equal(r.fellBackFrom, 'nearest');
});

check('edges with no coordinates fall back and admit it', () => {
  const flat = ALL.map(e => ({ ...e, lat: null, lon: null }));
  const r = chooseEdge(flat, { policy: 'nearest', viewer: BERLIN, channel: 'test2' });
  assert.equal(r.reason, 'edges-unlocated');
});

check('least-loaded with no load figures falls back and admits it', () => {
  const blind = ALL.map(e => ({ ...e, connections: undefined }));
  const r = chooseEdge(blind, { policy: 'least-loaded', channel: 'test2' });
  assert.equal(r.reason, 'load-unknown');
});

check('no healthy edge returns nothing, never a dead one', () => {
  // The single worst outcome available here is handing a viewer an edge the
  // panel already knows is down.
  const dead = ALL.map(e => ({ ...e, healthy: false }));
  const r = chooseEdge(dead, { policy: 'nearest', viewer: BERLIN, channel: 'test2' });
  assert.equal(r.edge, null);
  assert.equal(r.reason, 'no-healthy-edge');
});

console.log('\nWHAT THE VIEWER\'S URL REVEALS:');

check('direct mode exposes the edge address, and says so', () => {
  const u = viewerUrl({ mode: 'direct', edge: FRA, channel: 'test2', stream: 's' });
  assert.match(u.url, /^http:\/\/10\.0\.0\.3:8081\/test2\/s\/playlist\.m3u8$/);
  assert.equal(u.exposes, 'edge-address');
});

check('a redirect gateway without DNS names on the edges hides nothing', () => {
  // This is the configuration an operator sets up believing it does hide
  // something. The 302 target is an address the viewer receives.
  const u = viewerUrl({ mode: 'redirect', domain: 'cdn.example.com', edge: FRA, channel: 'test2', stream: 's' });
  assert.match(u.url, /^https:\/\/cdn\.example\.com\//);
  assert.equal(u.exposes, 'edge-address');
  assert.match(u.redirectsTo, /10\.0\.0\.3/);
});

check('a redirect gateway with named edges exposes only names', () => {
  const named = { ...FRA, publicHost: 'ed-fra.cdn.example.com' };
  const u = viewerUrl({ mode: 'redirect', domain: 'cdn.example.com', edge: named, channel: 'test2', stream: 's' });
  assert.equal(u.exposes, 'edge-name');
});

check('proxy mode exposes nothing', () => {
  const u = viewerUrl({ mode: 'proxy', domain: 'cdn.example.com', edge: FRA, channel: 'test2', stream: 's' });
  assert.equal(u.exposes, 'nothing');
  assert.equal(u.redirectsTo, undefined);
});

check('a gateway with no address degrades to the edge and reports it', () => {
  // Rather than producing "https:///test2/..." and a player that fails with
  // nothing to read.
  const u = viewerUrl({ mode: 'redirect', domain: '', node: null, edge: FRA, channel: 'test2', stream: 's' });
  assert.equal(u.degraded, 'gateway-has-no-address');
  assert.equal(u.via, 'edge');
});

console.log('\nTHE GATEWAY DECIDES LOCALLY:');

check('the routing table carries everything a choice needs', () => {
  // A gateway that asks the panel per viewer turns a panel outage into a
  // delivery outage — the correlation this design has avoided since the
  // conversation about self-hosting the repository.
  const t = routingTable({
    network: { name: 'prod', gateway: { policy: 'nearest', whenAllDown: 'fail' } },
    edges: ALL, channels: ['test2'],
  });
  assert.equal(t.policy, 'nearest');
  assert.equal(t.whenAllDown, 'fail');
  assert.equal(t.edges.length, 3);
  for (const e of t.edges) {
    assert.ok(e.host && e.port, 'an edge in the table cannot be reached');
    assert.ok('lat' in e && 'weight' in e, 'the table cannot reproduce the policy');
  }
});

check('the table is pure — no clock, no network', () => {
  // Stamped by the caller. A decision function that reaches out mid-decision
  // is neither reproducible nor arguable.
  const t = routingTable({ network: { name: 'x', gateway: {} }, edges: [], channels: [] });
  assert.equal(t.generatedAt, null);
});

console.log('\nSPREAD IS DETERMINISTIC:');

check('the same viewer key always gets the same edge', () => {
  // A player retrying must not open a second session on a different edge.
  const a = chooseEdge(ALL, { policy: 'weighted', channel: 'test2' });
  const b = chooseEdge(ALL, { policy: 'weighted', channel: 'test2' });
  assert.equal(a.edge.name, b.edge.name);
});

console.log(failures ? `\n${failures} arbiter check(s) failed` : '\nall arbiter checks passed');
process.exit(failures ? 1 : 0);
