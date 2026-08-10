// Network state, iter20 m3.
//
// m2 proved WMSPanel stored a route. Stored is not delivering: a route can be
// correct, present, and pointing at an origin with nothing on it, and every
// screen the panel had would have looked fine. These checks are about the
// distinctions that decide what an operator does next — and especially about
// keeping "we asked and there is nothing" apart from "we could not ask".
import assert from 'node:assert/strict';
import { networkState, indexStreams } from '../src/services/networkState.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const SERVERS = [
  { _id: 'origin', name: 'selectel(24/7)', wmspanelServerId: 'W-ORIGIN' },
  { _id: 'ru2', name: 'Nimble RU-2 (Только Раздача)', wmspanelServerId: 'W-RU2' },
];
const NET = { nodes: [
  { id: 'n-o', role: 'origin', server: 'origin', upstream: [], enabled: true },
  { id: 'n-2', role: 'edge', server: 'ru2', upstream: ['n-o'], enabled: true },
] };
const ROUTE = { id: 'r1', from: '/test2/', to: '79.98.187.66:8081/test2/', servers: ['W-RU2'] };

const streams = (...apps) => indexStreams({
  streams: apps.map(([application, stream, bandwidth]) => ({ application, stream, bandwidth })),
});

console.log('\nREADING WHAT A BOX REPORTS:');

check('applications are indexed with their bandwidth summed', () => {
  const m = streams(['test2', 'a', 1000], ['test2', 'b', 500], ['other', 'c', 7]);
  assert.equal(m.get('test2').length, 2);
  assert.equal(m.get('other')[0].bandwidth, 7);
});

check('a box with nothing on it indexes to an empty map, not to a failure', () => {
  assert.equal(indexStreams({ streams: [] }).size, 0);
  assert.equal(indexStreams(null).size, 0);
});

console.log('\nTHE VERDICTS THAT DECIDE WHAT TO DO NEXT:');

const state = (over = {}) => networkState({
  network: NET, servers: SERVERS, existingRoutes: [ROUTE], channels: ['test2'],
  live: { origin: streams(['test2', 's', 900]), ru2: streams(['test2', 's', 880]) },
  ...over,
});

check('content on both sides is flowing', () => {
  const r = state().rows[0];
  assert.equal(r.verdict, 'flowing');
  assert.equal(r.edge, 'Nimble RU-2 (Только Раздача)');
  assert.equal(r.origin, 'selectel(24/7)');
  assert.equal(r.edgeBandwidth, 880);
});

check('on the origin but not the edge is the route not working', () => {
  // The case the whole milestone exists for: everything m2 could see looks
  // right, and nothing reaches viewers.
  const r = state({ live: { origin: streams(['test2', 's', 900]), ru2: streams() } }).rows[0];
  assert.equal(r.verdict, 'origin-only');
  assert.equal(r.originBandwidth, 900);
  assert.equal(r.edgeStreams, 0);
});

check('nothing on either side is named as nothing upstream', () => {
  // Not a delivery fault: the operator has not started publishing. Saying
  // "route broken" here would send them to debug a working route.
  const r = state({ live: { origin: streams(), ru2: streams() } }).rows[0];
  assert.equal(r.verdict, 'nothing-upstream');
});

check('an application with no route says so before anything else', () => {
  const r = networkState({
    network: NET, servers: SERVERS, existingRoutes: [], channels: ['test2'],
    live: { origin: streams(['test2', 's', 900]), ru2: streams() },
  }).rows[0];
  assert.equal(r.verdict, 'no-route');
});

console.log('\n"COULD NOT ASK" IS NOT "NOTHING THERE":');

check('an unreachable edge is not reported as empty', () => {
  const r = state({ live: { origin: streams(['test2', 's', 900]), ru2: null } }).rows[0];
  assert.equal(r.verdict, 'edge-unreachable');
  assert.equal(r.edgeStreams, null, 'a count of zero would be a claim we cannot make');
});

check('an unreachable origin does not turn a working edge into a fault', () => {
  const r = state({ live: { origin: null, ru2: streams(['test2', 's', 880]) } }).rows[0];
  assert.equal(r.verdict, 'flowing', 'the edge is serving; the origin being unreachable is separate');
  assert.equal(r.originStreams, null);
});

check('unknown states are counted apart from broken ones', () => {
  const s = state({ live: { origin: streams(['test2', 's', 900]), ru2: null } });
  assert.equal(s.summary.unknown, 1);
  assert.equal(s.summary.broken, 0);
});

console.log('\nDRIFT — WHAT IS THERE THAT THE PLAN DOES NOT ACCOUNT FOR:');

check('a route nobody planned is surfaced, not silently ignored', () => {
  // /test1/ is exactly this on the real fleet: left over from the first
  // successful write. A view of "what is on my network" that omits it is
  // showing the plan, not the network.
  const extra = { id: 'r0', from: '/test1/', to: '79.98.187.66:8081/test1/', servers: ['W-RU2'] };
  const s = networkState({
    network: NET, servers: SERVERS, existingRoutes: [ROUTE, extra], channels: ['test2'],
    live: { origin: streams(), ru2: streams() },
  });
  const d = s.drift.find(x => x.code === 'unplanned-route');
  assert.ok(d, JSON.stringify(s.drift));
  assert.equal(d.from, '/test1/');
  assert.equal(d.routeId, 'r0');
});

check('a route left on a box that is no longer an edge is surfaced', () => {
  const onOrigin = { id: 'r9', from: '/test2/', to: 'x:8081/test2/', servers: ['W-ORIGIN'] };
  const s = networkState({
    network: NET, servers: SERVERS, existingRoutes: [ROUTE, onOrigin], channels: ['test2'],
    live: {},
  });
  assert.ok(s.drift.some(x => x.code === 'route-on-non-edge' && x.routeId === 'r9'));
});

check('a route on servers outside this network is not this network\'s drift', () => {
  const elsewhere = { id: 'r8', from: '/x/', to: 'y:8081/x/', servers: ['W-SOMEONE-ELSE'] };
  const s = networkState({
    network: NET, servers: SERVERS, existingRoutes: [ROUTE, elsewhere], channels: ['test2'], live: {},
  });
  assert.ok(!s.drift.some(x => x.routeId === 'r8'));
});

console.log(failures ? `\n${failures} network-state check(s) failed` : '\nall network-state checks passed');
process.exit(failures ? 1 : 0);
