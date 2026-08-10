// The delivery plan, iter20 m2.
//
// Built on the fleet's own shape rather than a toy one: selectel(24/7) as the
// origin and the two boxes the operator already named "Только Раздача" as
// edges — which is the point of m1, that the intent was in the server's name
// and nowhere a program could read it.
//
// The account's live inventory returned {"status":"Ok","routes":[]}: there is
// not one re-streaming route in it yet, and the official reference only ever
// shows `to` pointing at file:/// for VOD. So the URL shape an edge needs is
// derived here and verified by reading back after the first write, not
// asserted as known.
import assert from 'node:assert/strict';
import { planRoutes, routeFrom, routeTo, originHttpPort, NIMBLE_DEFAULT_HTTP_PORT }
  from '../src/services/deliveryPlan.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

// The real fleet, trimmed to what a plan touches.
const SERVERS = [
  { _id: 'origin', name: 'selectel(24/7)', host: '10.0.0.10', httpPort: 8081, wmspanelServerId: '683d9d7ea41cacbce6db5196' },
  { _id: 'ru2', name: 'Nimble RU-2 (Только Раздача)', host: '10.0.0.20', httpPort: 0, wmspanelServerId: '6a18e008dc73c6feb3a4f1e9' },
  { _id: 'ru3', name: 'NimbleRU-3 (Только Раздача)', host: '10.0.0.30', httpPort: 0, wmspanelServerId: '6a4227ddc12a819680841f26' },
  { _id: 'unmapped', name: 'Сердце Пальмиры', host: '10.0.0.40', httpPort: 0, wmspanelServerId: '' },
];

const net = (nodes) => ({ nodes });
const N = (id, role, server, upstream = [], extra = {}) => ({ id, role, server, upstream, enabled: true, ...extra });
const BASE = net([
  N('n-o', 'origin', 'origin', ['n-i']),
  N('n-i', 'ingest', 'origin'),
  N('n-2', 'edge', 'ru2', ['n-o']),
  N('n-3', 'edge', 'ru3', ['n-o']),
]);

console.log('\nTHE URL SHAPE:');

check('a route claims a path on any address the edge answers on', () => {
  // An empty domain in `from` is the documented way to say "every address this
  // box serves". An edge is reached by IP today and by a DNS name later, and
  // pinning a domain now would break the second.
  assert.equal(routeFrom('kp_24-7'), '/kp_24-7/');
  assert.equal(routeFrom('/kp_24-7/'), '/kp_24-7/');
  assert.equal(routeFrom('//weird//'), '/weird/');
});

check('the target is host:port and a path, not a URL', () => {
  // Learned from the first live write, not from the reference. WMSPanel
  // answered the URL form with "Target Domain and Port must be specified
  // (e.g 127.0.0.1:8080)" — the scheme hid both from its parser.
  assert.equal(routeTo('10.0.0.10', 8081, 'kp_24-7'), '10.0.0.10:8081/kp_24-7/');
});

check('no scheme survives in a target', () => {
  // The single character that cost a release cycle. Asserted separately so it
  // cannot come back through some other formatting change.
  for (const host of ['10.0.0.10', 'origin.example.com']) {
    assert.ok(!routeTo(host, 8081, 'app').includes('://'),
      'a scheme in `to` makes WMSPanel see neither domain nor port');
  }
});

check('an unset http port falls back to the documented default and says so', () => {
  assert.deepEqual(originHttpPort({ httpPort: 0 }), { port: NIMBLE_DEFAULT_HTTP_PORT, source: 'nimble-default' });
  assert.deepEqual(originHttpPort({ httpPort: 8090 }), { port: 8090, source: 'configured' });
});

console.log('\nTHE PLAN ON THE REAL TOPOLOGY:');

check('two edges and one channel plan two routes', () => {
  const p = planRoutes({ network: BASE, servers: SERVERS, channels: ['kp_24-7'] });
  assert.equal(p.summary.create, 2, JSON.stringify(p.planned));
  assert.deepEqual(p.blocking, []);
  const hosts = p.planned.map(x => x.wmspanelServerId).sort();
  assert.deepEqual(hosts, ['6a18e008dc73c6feb3a4f1e9', '6a4227ddc12a819680841f26'].sort());
  assert.ok(p.planned.every(x => x.to === '10.0.0.10:8081/kp_24-7/'));
});

check('the assumed port is reported as an assumption, not silently used', () => {
  const noPort = SERVERS.map(s => (s._id === 'origin' ? { ...s, httpPort: 0 } : s));
  const p = planRoutes({ network: BASE, servers: noPort, channels: ['kp_24-7'] });
  const w = p.problems.find(x => x.code === 'origin-http-port-assumed');
  assert.ok(w, JSON.stringify(p.problems));
  assert.equal(w.severity, 'warn');
  assert.equal(w.port, NIMBLE_DEFAULT_HTTP_PORT);
});

check('an edge with nothing above it is refused, not silently skipped', () => {
  const p = planRoutes({ network: net([N('n-2', 'edge', 'ru2')]), servers: SERVERS, channels: ['x'] });
  assert.ok(p.blocking.some(x => x.code === 'edge-without-upstream'));
});

check('an edge WMSPanel does not know is refused', () => {
  const p = planRoutes({
    network: net([N('n-o', 'origin', 'origin'), N('n-u', 'edge', 'unmapped', ['n-o'])]),
    servers: SERVERS, channels: ['x'],
  });
  assert.ok(p.blocking.some(x => x.code === 'edge-not-mapped'));
});

console.log('\nHTTP ORIGIN AND CACHING CANNOT BOTH BE ON:');

check('an application in HTTP Origin mode on an edge blocks the route', () => {
  // Softvelum are explicit: HLS re-streaming is not cached while HTTP Origin
  // mode is enabled. This fleet already runs it — blastdotakk across three
  // servers, RU-2 among them. Route that application to RU-2 as a caching edge
  // and every viewer fetches every chunk from the origin: it works, it reports
  // nothing, and origin traffic multiplies by the audience.
  const p = planRoutes({
    network: BASE, servers: SERVERS, channels: ['blastdotakk'],
    originApps: [{ application: 'blastdotakk', server_ids: ['6a18e008dc73c6feb3a4f1e9', '683d9d7ea41cacbce6db5196'] }],
  });
  const b = p.blocking.find(x => x.code === 'http-origin-disables-cache');
  assert.ok(b, JSON.stringify(p.problems));
  assert.match(b.detail, /not cached/);
  assert.equal(b.server, 'Nimble RU-2 (Только Раздача)');
});

check('the other edge is still planned — the block is per server, not global', () => {
  const p = planRoutes({
    network: BASE, servers: SERVERS, channels: ['blastdotakk'],
    originApps: [{ application: 'blastdotakk', server_ids: ['6a18e008dc73c6feb3a4f1e9'] }],
  });
  assert.equal(p.summary.create, 1);
  assert.equal(p.planned[0].server, 'NimbleRU-3 (Только Раздача)');
});

check('HTTP Origin on the origin itself is not a problem', () => {
  // It is the normal setup: an origin serving CDNs session-free. Only the edge
  // side loses its cache.
  const p = planRoutes({
    network: BASE, servers: SERVERS, channels: ['blastdotakk'],
    originApps: [{ application: 'blastdotakk', server_ids: ['683d9d7ea41cacbce6db5196'] }],
  });
  assert.deepEqual(p.blocking, []);
  assert.equal(p.summary.create, 2);
});

console.log('\nRE-RUNNING A PLAN DOES NOT DUPLICATE IT:');

const EXISTING = [{
  id: 'r1', from: '/kp_24-7/', to: '10.0.0.10:8081/kp_24-7/',
  servers: ['6a18e008dc73c6feb3a4f1e9'],
}];

check('an identical route is kept, not created again', () => {
  const p = planRoutes({ network: BASE, servers: SERVERS, channels: ['kp_24-7'], existingRoutes: EXISTING });
  assert.equal(p.summary.keep, 1);
  assert.equal(p.summary.create, 1);
});

check('the same path pointing elsewhere is an update, and the old target is shown', () => {
  const moved = [{ ...EXISTING[0], to: '10.0.0.99:8081/kp_24-7/' }];
  const p = planRoutes({ network: BASE, servers: SERVERS, channels: ['kp_24-7'], existingRoutes: moved });
  const u = p.planned.find(x => x.action === 'update');
  assert.ok(u);
  assert.equal(u.was, '10.0.0.99:8081/kp_24-7/');
  assert.equal(u.routeId, 'r1');
});

check('a route on another server does not count as this one', () => {
  const elsewhere = [{ ...EXISTING[0], servers: ['someone-else'] }];
  const p = planRoutes({ network: BASE, servers: SERVERS, channels: ['kp_24-7'], existingRoutes: elsewhere });
  assert.equal(p.summary.create, 2);
  assert.equal(p.summary.keep, 0);
});

console.log('\nEDGES OF THE PLAN:');

check('two upstreams use one and say the second was ignored', () => {
  const two = net([
    N('n-a', 'origin', 'origin'), N('n-b', 'origin', 'ru3'),
    N('n-2', 'edge', 'ru2', ['n-a', 'n-b']),
  ]);
  const p = planRoutes({ network: two, servers: SERVERS, channels: ['x'] });
  assert.ok(p.problems.some(x => x.code === 'multiple-upstreams-ignored' && x.severity === 'warn'));
  assert.equal(p.summary.create, 1);
});

check('a network with no channels plans nothing and is not an error', () => {
  const p = planRoutes({ network: BASE, servers: SERVERS, channels: [] });
  assert.equal(p.planned.length, 0);
  assert.deepEqual(p.blocking, []);
  assert.ok(p.problems.some(x => x.code === 'no-channels' && x.severity === 'note'));
});

check('a disabled edge is left out', () => {
  const off = net([N('n-o', 'origin', 'origin'), { ...N('n-2', 'edge', 'ru2', ['n-o']), enabled: false }]);
  const p = planRoutes({ network: off, servers: SERVERS, channels: ['x'] });
  assert.equal(p.planned.length, 0);
});


console.log('\nA FAILED APPLY REACHES THE OPERATOR:');

// The plan, the read-back and the rollback all existed and all worked, and
// none of it was visible: the panel read the response body off `e.body` while
// api.js puts it on `e.data`, so a failed apply arrived as "HTTP 502" with the
// steps — which route stopped it, what WMSPanel said, what was rolled back —
// discarded on the way. Two files disagreeing about one property name threw
// away the entire point of running a plan.
//
// So the contract is asserted from both ends rather than trusted.
const readFile = (await import('node:fs')).readFileSync;
const FRONT = new URL('../../frontend/src/', import.meta.url);
const apiSrc = readFile(new URL('api.js', FRONT), 'utf8');
const panelSrc = readFile(new URL('components/DeliveryRoutesPanel.jsx', FRONT), 'utf8');
// Comments explain the contract and would satisfy a check for it. Stripped, so
// the assertion looks at what runs — the first version of this check passed on
// a file whose only mention of the property was the sentence describing it.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const panelCode = stripComments(panelSrc);

check('api.js attaches the response body to a named property', () => {
  const m = apiSrc.match(/err\.(\w+)\s*=\s*data;/);
  assert.ok(m, 'api.js no longer attaches the parsed body to the error');
  assert.equal(m[1], 'data');
});

check('the panel reads the same property api.js writes', () => {
  const m = apiSrc.match(/err\.(\w+)\s*=\s*data;/);
  const prop = m[1];
  assert.ok(new RegExp(`e\\.${prop}`).test(panelCode),
    `the panel does not read e.${prop}, so every failure would arrive as a bare status line`);
});

check('a failed apply renders its steps, not just its status', () => {
  assert.ok(/d\.steps/.test(panelCode), 'the steps of a failed apply are not shown');
  assert.ok(/setReport\(d\)/.test(panelCode));
});

check("what WMSPanel said is carried to the step, not collapsed into a code", () => {
  const routes = readFile(new URL('../src/routes/deliveryRoutes.js', import.meta.url), 'utf8');
  assert.ok(/upstreamError:/.test(stripComments(routes)), 'the upstream body never reaches the step');
  assert.ok(/upstreamError/.test(panelCode), 'the step carries it and the panel drops it');
});

check('a create with no id looks for the route before calling it a failure', () => {
  // A response without an id is not proof that nothing was written, and
  // rolling back on that assumption would delete a route that exists.
  const routes = readFile(new URL('../src/routes/deliveryRoutes.js', import.meta.url), 'utf8');
  assert.ok(/routeList\(c\)\.catch/.test(stripComments(routes)), 'the missing-id path does not re-read the list');
});

console.log(failures ? `\n${failures} delivery-plan check(s) failed` : '\nall delivery-plan checks passed');
process.exit(failures ? 1 : 0);
