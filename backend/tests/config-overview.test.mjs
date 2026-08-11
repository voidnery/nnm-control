// Configuration at a glance, iter20.
//
// The point is not to list settings — it is to surface the ones that do
// something other than they read. Each check below is a configuration that is
// valid everywhere it appears and wrong in combination, which is precisely the
// class no single screen can catch.
import assert from 'node:assert/strict';
import { configOverview } from '../src/services/configOverview.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const S = (id, name, over = {}) => ({
  _id: id, name, host: `10.0.0.${id.length}`, httpPort: 8081,
  wmspanelServerId: `W-${id}`, agent: { enabled: true, version: 20 },
  geo: { lat: 55.7, lon: 37.6 }, playbackEndpoints: [], ...over,
});
const SERVERS = [S('o', 'selectel(24/7)'), S('e2', 'Nimble RU-2'), S('e3', 'Nimble RU-3')];
const NET = (over = {}) => ({
  name: 'prod', audience: 'internal',
  nodes: [
    { id: 'n-o', role: 'origin', server: 'o', upstream: ['n-i'], enabled: true },
    { id: 'n-2', role: 'edge', server: 'e2', upstream: ['n-o'], enabled: true },
  ],
  gateway: { mode: 'direct', policy: 'nearest', whenAllDown: 'fail', domain: '', node: null },
  ...over,
});
const GEO = { present: true, edition: 'city', hasCoordinates: true };
const has = (r, code) => r.findings.some(f => f.code === code);

const base = (over = {}) => configOverview({
  network: NET(), servers: SERVERS, geo: GEO, ...over,
});

console.log('\nA CLEAN NETWORK IS QUIET:');

check('nothing is reported about a network that is fine', () => {
  const r = base();
  assert.equal(r.counts.block, 0, JSON.stringify(r.findings));
  assert.equal(r.counts.warn, 0, JSON.stringify(r.findings));
});

check('the settings themselves are returned, not only the problems', () => {
  // "What is enabled" must not have to be read backwards out of a list of
  // complaints.
  const r = base();
  assert.equal(r.summary.gateway.mode, 'direct');
  assert.equal(r.summary.gateway.policy, 'nearest');
  assert.equal(r.summary.roles.edge, 1);
  assert.equal(r.summary.agents, 2);
});

console.log('\nCOMBINATIONS NO SINGLE SCREEN CAN CATCH:');

check('HTTP Origin on an edge is surfaced as blocking, when it is delivered here', () => {
  // Valid on the account objects page, valid on the topology page, and
  // together they mean the edge does not cache: every viewer fetches every
  // chunk from the origin. Nothing on either screen mentions the other.
  const r = base({ channels: ['blastdotakk'], routes: [{ id: 'r', from: '/blastdotakk/', to: 'x', servers: ['W-e2'] }],
                   originApps: [{ application: 'blastdotakk', server_ids: ['W-e2'] }] });
  const f = r.findings.find(x => x.code === 'http-origin-on-edge');
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.severity, 'block');
  assert.equal(f.application, 'blastdotakk');
  assert.match(f.subject, /RU-2/);
});

check('an application this network does not deliver is a note, not a block', () => {
  // blastdotakk was in HTTP Origin mode on a box that happens to be an edge
  // here, and the panel reported it in red on a network that does not carry
  // it. Red that usually means nothing teaches an operator to ignore red.
  const r = base({ originApps: [{ application: 'blastdotakk', server_ids: ['W-e2'] }] });
  assert.equal(r.counts.block, 0, JSON.stringify(r.findings));
  assert.ok(has(r, 'http-origin-on-edge-maybe'));
});

check('an origin is not asked what it takes content from', () => {
  // An origin is fed by whatever publishes into it — an encoder, vMix, an SRT
  // caller — none of which the panel models. "Takes content from nothing"
  // about an origin describes the normal case and demands an action that does
  // not exist. It was the first thing an operator asked about, on a network
  // that was delivering video at the time.
  const net = NET({ nodes: [
    { id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true },
    { id: 'n-2', role: 'edge', server: 'e2', upstream: ['n-o'], enabled: true },
  ] });
  const r = configOverview({ network: net, servers: SERVERS, geo: GEO });
  assert.equal(has(r, 'node-without-upstream'), false, JSON.stringify(r.findings));
});

check('an edge with nothing above it is still asked', () => {
  // The rule narrowed, it did not go away.
  const net = NET({ nodes: [
    { id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true },
    { id: 'n-2', role: 'edge', server: 'e2', upstream: [], enabled: true },
  ] });
  assert.ok(has(configOverview({ network: net, servers: SERVERS, geo: GEO }), 'node-without-upstream'));
});

check('HTTP Origin on the origin alone is not reported', () => {
  // That is the normal setup — serving CDNs session-free. Only the edge side
  // loses its cache.
  const r = base({ originApps: [{ application: 'blastdotakk', server_ids: ['W-o'] }] });
  assert.equal(has(r, 'http-origin-on-edge'), false);
});

check('an unset origin port is surfaced, because every route guesses it', () => {
  const servers = SERVERS.map(s => (s._id === 'o' ? { ...s, httpPort: 0 } : s));
  assert.ok(has(base({ servers }), 'origin-port-guessed'));
});

check('"nearest" over an edge with no coordinates is a policy that cannot run', () => {
  const servers = SERVERS.map(s => (s._id === 'e2' ? { ...s, geo: {} } : s));
  assert.ok(has(base({ servers }), 'edge-without-coordinates'));
});

check('the same edge without coordinates is silent under another policy', () => {
  // It is only worth saying when it changes what happens.
  const servers = SERVERS.map(s => (s._id === 'e2' ? { ...s, geo: {} } : s));
  const r = configOverview({ network: NET({ gateway: { mode: 'direct', policy: 'weighted' } }), servers, geo: GEO });
  assert.equal(has(r, 'edge-without-coordinates'), false);
});

console.log('\nTHE GATEWAY:');

check('a non-direct gateway with no node cannot work', () => {
  const r = configOverview({
    network: NET({ gateway: { mode: 'redirect', policy: 'weighted', node: null, domain: 'cdn.x' } }),
    servers: SERVERS, geo: GEO,
  });
  const f = r.findings.find(x => x.code === 'gateway-without-node');
  assert.equal(f?.severity, 'block');
});

check('a gateway node without an agent cannot be handed a routing table', () => {
  const servers = [...SERVERS, S('gw', 'gateway-vm', { agent: { enabled: false } })];
  const r = configOverview({
    network: NET({ gateway: { mode: 'proxy', policy: 'weighted', node: 'gw', domain: 'cdn.x' } }),
    servers, geo: GEO,
  });
  assert.ok(has(r, 'gateway-node-without-agent'));
});

check('a redirect gateway over unnamed edges reveals them, and says so', () => {
  // The configuration people set up believing it hides the edges. The 302
  // target is an address the viewer receives.
  const servers = [...SERVERS, S('gw', 'gateway-vm')];
  const r = configOverview({
    network: NET({ gateway: { mode: 'redirect', policy: 'weighted', node: 'gw', domain: 'cdn.x' } }),
    servers, geo: GEO,
  });
  assert.ok(has(r, 'redirect-reveals-edges'));
});

check('a redirect gateway over named edges is quiet', () => {
  const servers = [S('o', 'selectel(24/7)'), S('e2', 'Nimble RU-2', { playbackEndpoints: [{ host: 'ed-ru2.cdn.x' }] }), S('gw', 'gateway-vm')];
  const r = configOverview({
    network: NET({ gateway: { mode: 'redirect', policy: 'weighted', node: 'gw', domain: 'cdn.x' } }),
    servers, geo: GEO,
  });
  assert.equal(has(r, 'redirect-reveals-edges'), false);
});

console.log('\nROUTES AGAINST THE PLAN:');

check('a channel with no route on an edge is surfaced', () => {
  const r = base({ channels: ['test2'], routes: [] });
  assert.ok(has(r, 'channel-without-route'));
});

check('a route nobody planned is a note, not a fault', () => {
  // An operator may run routes this panel did not create.
  const r = base({ channels: ['test2'], routes: [
    { id: 'r1', from: '/test2/', to: 'x:8081/test2/', servers: ['W-e2'] },
    { id: 'r0', from: '/test1/', to: 'x:8081/test1/', servers: ['W-e2'] },
  ] });
  const f = r.findings.find(x => x.code === 'route-not-in-plan');
  assert.equal(f?.severity, 'note');
  assert.equal(has(r, 'channel-without-route'), false);
});

console.log('\nORDER AND SEVERITY:');

check('blocking findings come first', () => {
  const r = base({ channels: ['a'], routes: [],
                   originApps: [{ application: 'a', server_ids: ['W-e2'] }] });
  assert.equal(r.findings[0].severity, 'block', JSON.stringify(r.findings.map(f => [f.code, f.severity])));
});

check('a missing agent is a note, not a warning', () => {
  // It works while the box is reachable. It is worth knowing, not worth
  // shouting — the panel has cried wolf enough this iteration.
  const servers = SERVERS.map(s => (s._id === 'e2' ? { ...s, agent: { enabled: false } } : s));
  const f = base({ servers }).findings.find(x => x.code === 'node-without-agent');
  assert.equal(f?.severity, 'note');
});

check('an agent too old to probe is named separately from having none', () => {
  const servers = SERVERS.map(s => (s._id === 'e2' ? { ...s, agent: { enabled: true, version: 19 } } : s));
  const f = base({ servers }).findings.find(x => x.code === 'agent-cannot-probe');
  assert.equal(f?.need, 20);
  assert.equal(f?.have, 19);
});

console.log(failures ? `\n${failures} config-overview check(s) failed` : '\nall config-overview checks passed');
process.exit(failures ? 1 : 0);
