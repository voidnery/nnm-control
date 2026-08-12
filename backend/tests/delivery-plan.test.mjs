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

check('the panel shows the routes that exist, not only the ones it would make', () => {
  // A route was written, reported "read-back matches", and there was nowhere
  // in the panel to see it: the page showed intent and never state, and
  // WMSPanel's own list is three menus away and one server at a time.
  assert.ok(/api\('\/cdn\/routes'\)/.test(panelCode), 'the panel never asks what exists');
  assert.ok(/loadLive/.test(panelCode));
  // Refreshed after a write, or the list is stale exactly when it is read.
  assert.ok(/await loadLive\(\)/.test(panelCode), 'the list is not refreshed after an apply');
});

check('WMSPanel server ids are shown as fleet names', () => {
  // "6a18e008dc73c6feb3a4f1e9" tells an operator nothing about which box a
  // route landed on.
  assert.ok(/wmspanelServerId/.test(panelCode) && /nameOf/.test(panelCode));
});

console.log('\nSTATE AND DELETION REACH THE PANEL:');

check('the panel asks the servers, not only the plan', () => {
  assert.ok(/networks\/\$\{network\.id\}\/state/.test(panelCode), 'nothing reads live state');
  assert.ok(/loadState/.test(panelCode));
});

check('a route can be removed from the panel that created it', () => {
  // A panel that writes and cannot unwrite leaves the operator in WMSPanel,
  // three menus deep, per server, to undo what this page did.
  assert.ok(/method: 'DELETE'/.test(panelCode), 'no delete call');
  assert.ok(/confirmDelete2/.test(panelCode), 'deletion is not confirmed');
});

check('the confirmation says what a viewer will notice', () => {
  // "Are you sure" about an invisible consequence is not a confirmation.
  const dict = readFile(new URL('i18n.jsx', FRONT), 'utf8');
  const ru = dict.match(/'cdn\.confirmDelete2':\s*'([^']+)'/g) || [];
  assert.ok(ru.length === 2, 'the confirmation is missing from a dictionary');
  assert.ok(ru.every(x => /viewers|зрител/i.test(x)),
    'the confirmation does not mention that delivery stops');
});

check('a missing reading never renders as a number', () => {
  // Printing 0 where a box could not be asked is a claim the panel cannot
  // make, and it is the difference between "nothing is streaming" and "we do
  // not know".
  //
  // Asserted across whichever component renders readings rather than against
  // one file: this check went red when the rendering moved to the flow board
  // and the rule had not changed at all. A gate tied to a location tests the
  // location.
  const renderers = ['components/DeliveryRoutesPanel.jsx', 'components/DeliveryFlowBoard.jsx']
    .map(f => stripComments(readFile(new URL(f, FRONT), 'utf8')))
    .filter(src => /streams/.test(src) && /Bandwidth|bandwidth/.test(src));
  assert.ok(renderers.length, 'nothing renders readings any more');
  // Every renderer, not any: `some` passes as soon as one file still has the
  // check, which is how a rule survives in a file nobody looks at while the
  // one on screen quietly drops it.
  // Tied to the count itself. A loose "is there a null check anywhere in the
  // file" passed while the guard around the stream count was gone, because a
  // bandwidth formatter elsewhere in the same file had one — the check was
  // matching a different rule that happened to look the same.
  for (const src of renderers) {
    assert.ok(/streams\s*(===|==)\s*(null|undefined)/.test(src),
      'a component renders a stream count without distinguishing a missing reading from zero');
  }
});

console.log('\nNATIVE READS GO THROUGH THE AGENT-PREFERRING CLIENT:');

check('management reads go through the agent-preferring client', () => {
  // The rule is about the *management API*: it lives in one place —
  // nimbleClient, which prefers the agent and falls back only for servers
  // without one — and it holds only while every caller goes through it.
  //
  // Not about every outbound request. The watch probe is a plain HTTP GET to
  // the playback port, from outside the edge, because that is precisely what a
  // viewer does; routing it through the agent would have the edge fetch from
  // itself and test a loop. The first version of this check banned `fetch(`
  // outright and would have forbidden the one thing that finally told the
  // truth about delivery.
  const routes = stripComments(readFile(new URL('../src/routes/deliveryRoutes.js', import.meta.url), 'utf8'));
  const state = stripComments(readFile(new URL('../src/services/networkState.js', import.meta.url), 'utf8'));

  assert.ok(!/\bfetch\s*\(/.test(state), 'networkState.js dials a server itself');
  // No management path may be reached by hand.
  assert.ok(!/fetch\([^)]*\/manage\//.test(routes),
    'deliveryRoutes.js reaches the management API without nimbleClient');
  assert.ok(/from '\.\.\/services\/nimbleClient\.js'/.test(routes),
    'the state endpoint does not use the shared native client at all');

  // Every bare fetch in this file must be the viewer probe: aimed at the
  // playback port, at a path the playlist helper built.
  const bare = [...routes.matchAll(/\bfetch\s*\(([^;]{0,120})/g)].map(m => m[1]);
  for (const call of bare) {
    assert.ok(/url/.test(call), `an unrecognised bare fetch: ${call.slice(0, 60)}`);
  }
  // Bound to the helper actually producing the path that gets fetched, not to
  // the helper merely being imported: inlining the path string satisfied
  // "playlistPath appears in the file" while quietly dropping the one place
  // the path is defined, so the probe and the plan could drift apart.
  if (bare.length) {
    // Either helper: playlistPath was the HLS-only one, playbackPath covers
    // every packaging and produces the identical path for HLS. What matters is
    // that the probe and the link are built by the same code, not which of the
    // two it is.
    assert.ok(/const path = (playlistPath|playbackPath)\(/.test(routes),
      'the probed path is built by hand instead of by a shared helper');
    assert.ok(/httpPort \|\| 8081/.test(routes), 'the probe does not aim at the playback port');
  }
});

check('the transport is asked for, not assumed', () => {
  const routes = stripComments(readFile(new URL('../src/routes/deliveryRoutes.js', import.meta.url), 'utf8'));
  assert.ok(/liveStreams\(s, meta\)/.test(routes), 'the read does not collect its transport');
  assert.ok(/agentIsLive/.test(routes), 'nothing distinguishes a box with an agent from one without');
});

console.log('\nTHE PAGE EXPLAINS ITSELF:');

const boardSrc = readFile(new URL('components/DeliveryFlowBoard.jsx', FRONT), 'utf8');
const boardCode = stripComments(boardSrc);
const dict = readFile(new URL('i18n.jsx', FRONT), 'utf8');

check('delivery is drawn as a flow, not tabulated', () => {
  // The state was a table of "on origin / on edge / verdict": every fact
  // present, none of it legible. Reading it meant holding the direction of the
  // flow in your head and mapping two numbers onto it — the job a picture does
  // for free, and the one the transcoder screens already do this way.
  assert.ok(/gpipe-card/.test(boardCode) && /garrow/.test(boardCode),
    'the flow board no longer uses the shared three-stage layout');
  assert.ok(/originCol|routeCol|edgeCol/.test(boardCode), 'the stages are unlabelled');
});

// Superseded: this listed the verdicts by hand and went stale the moment
// 'origin-only' was replaced by 'idle'. The version further down reads them
// out of the service, which cannot go stale in the same way.

check('the applications are offered, not demanded', () => {
  // The rule: an operator never types a name the origin already knows.
  //
  // It has now moved twice — from a text box, to chips on the delivery tab, to
  // the channels tab where channels are created — and this assertion has gone
  // red on both moves while the rule held throughout. Bound to the outcome
  // this time: something reads what the origins publish, and one click turns
  // one of those into a channel. Which file does it is not the rule.
  const front = ['components/DeliveryRoutesPanel.jsx', 'components/ChannelsPanel.jsx']
    .map(f => stripComments(readFile(new URL(f, FRONT), 'utf8')));
  assert.ok(front.some(src => /\/channels\/discovered|\/applications/.test(src)),
    'nothing reads what the origins are publishing');
  assert.ok(front.some(src => /setEdit\(\{ application: f\.application/.test(src)),
    'a discovered stream cannot be turned into a channel in one click');
});

check('a channel has exactly one place it is created', () => {
  // It had two — the delivery tab and the channels tab — so an application had
  // two homes and the operator had to know which one counted. That is the
  // duplication this milestone exists to remove.
  // Matched on the endpoint, not on the body. The first version matched
  // `body: { application` and hit the viewer probe, which posts an application
  // and a stream to /watch and creates nothing — a rule firing on unrelated
  // code, which is the same fault as a rule firing on nothing.
  const deliv = stripComments(readFile(new URL('components/DeliveryRoutesPanel.jsx', FRONT), 'utf8'));
  assert.ok(!/api\('\/cdn\/channels',\s*\{\s*method: 'POST'/.test(deliv),
    'the delivery tab creates channels as well as the channels tab');
  const chans = stripComments(readFile(new URL('components/ChannelsPanel.jsx', FRONT), 'utf8'));
  assert.ok(/api\('\/cdn\/channels',\s*\{\s*method: 'POST'/.test(chans),
    'nowhere creates channels at all');
});

check('a box with no reading still explains itself on the board', () => {
  assert.ok(/cdn\.noReading/.test(boardCode));
  assert.ok(/cdn\.reason\./.test(boardCode), 'a failed read shows no reason on the board');
});

console.log('\nTHE PAGE HAS A SHAPE, NOT A STACK:');

const netSrc = stripComments(readFile(new URL('components/DeliveryNetworkPanel.jsx', FRONT), 'utf8'));

check('a network shows one job at a time', () => {
  // Four panels stacked vertically, each growing downwards on every button
  // press, is a page nobody can hold in view. These are separate jobs done at
  // separate moments and each gets a tab.
  //
  // The required set, not the exact list: this went red the moment a fifth tab
  // was added, about a rule that had not changed. A gate matching a literal
  // enumeration forbids growth rather than the thing it cares about.
  // The required set moved in iter21 m4: topology, delivery and gateway became
  // steps inside `setup` rather than tabs beside it, because six equal tabs
  // answer "where is that setting" and never "what do I do next". What
  // survived is the rule — one job at a time, every declared tab renders
  // something — not the particular jobs.
  const required = ['setup', 'probes'];
  const declared = netSrc.match(/\{\[((?:'[a-z]+',?\s*)+)\]\.map\(v =>/)?.[1] || '';
  const tabs = [...declared.matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(tabs.length >= required.length, `only ${tabs.length} tab(s) declared`);
  for (const tab of required) {
    assert.ok(tabs.includes(tab), `the ${tab} tab is no longer declared`);
    assert.ok(new RegExp(`tab === '${tab}'`).test(netSrc), `nothing renders on the ${tab} tab`);
  }
  // Every declared tab must render something, or it is a dead button.
  for (const tab of tabs) {
    assert.ok(new RegExp(`tab === '${tab}'`).test(netSrc), `the ${tab} tab renders nothing`);
  }
});

check('unsaved topology is visible from the other tabs', () => {
  // The plan is computed from what is stored. An operator who edited the
  // topology and moved to Delivery has no way to see that what they are
  // planning against is not what is on their screen — so the tab carries the
  // mark.
  const tabBar = netSrc.slice(netSrc.indexOf(".map(v => ("));
  assert.ok(/dirty/.test(tabBar.slice(0, 600)), 'the topology tab does not mark unsaved changes');
});

check('the delivery steps are ordered, not three equal buttons', () => {
  for (const k of ['cdn.step1', 'cdn.step2', 'cdn.step3']) {
    assert.ok(new RegExp(`t\\('${k}'\\)`).test(panelCode), `${k} is not rendered as a step heading`);
  }
  // There is no "plan first" any more: iter21 m3 derives what Nimble needs
  // from the network's channels, so step 2 is the panel reporting what it will
  // do rather than the operator asking it to work it out. The rule that
  // survived is that the state of step 2 is legible — set up, or how much is
  // left — and that the two are told apart.
  assert.ok(/cdn\.inSync/.test(panelCode) && /cdn\.pendingN/.test(panelCode),
    'step 2 cannot say whether the servers are set up');
});

check('the written routes are reference, not part of the flow', () => {
  // Folded, with the count showing, so it is never a surprise that something
  // is there — but it is not competing with the three steps for attention.
  //
  // Checked as state that starts closed and can be toggled, not merely as a
  // name that appears: a `const showLive = true` satisfies "showLive exists"
  // and unfolds the list permanently, which is the thing being prevented.
  assert.ok(/useState\(false\)/.test(panelCode.slice(panelCode.indexOf('showLive') - 60,
                                                     panelCode.indexOf('showLive') + 80)),
    'the written-routes list does not start folded');
  assert.ok(/setShowLive\(v => !v\)/.test(panelCode), 'the fold cannot be toggled');
});

console.log('\nCONFIGURED, WORKS, IN USE — THREE FACTS:');

check('the board states each of the three separately', () => {
  // They answer three different questions and were crushed into one verdict.
  // The middle one is the only question a pull-based edge can be asked, and it
  // used to be inferred from the third — which is how a working network read
  // as broken for three milestones.
  for (const k of ['cdn.f.configured', 'cdn.f.works', 'cdn.f.inUse']) {
    assert.ok(new RegExp(`t\\('${k}'\\)`).test(boardCode), `${k} is not shown`);
  }
});

check('an unchecked edge says so rather than looking broken', () => {
  assert.ok(/cdn\.notChecked/.test(boardCode));
});

check('"at rest" is not painted as an error', () => {
  // The single change that matters most: a routed edge with no viewers is the
  // resting state of every correct edge on the fleet.
  const tone = boardCode.slice(boardCode.indexOf('const TONE'), boardCode.indexOf('const WATCH_TONE'));
  assert.ok(/idle:\s*''/.test(tone), 'idle carries a tone that reads as a fault');
  assert.ok(!/origin-only/.test(boardCode), 'the old alarming verdict is still rendered');
});

check('every verdict the service can produce has a sentence, in both languages', () => {
  // Read from the service rather than listed here, so a verdict added later
  // cannot reach the screen as a raw key.
  const svc = readFile(new URL('../src/services/networkState.js', import.meta.url), 'utf8');
  const verdicts = [...new Set([...stripComments(svc).matchAll(/verdict = '([a-z-]+)'/g)].map(m => m[1]))];
  assert.ok(verdicts.length >= 4, `only found ${verdicts.length} verdicts`);
  for (const v of verdicts) {
    assert.equal((dict.match(new RegExp(`'cdn\\.explain\\.${v}':`, 'g')) || []).length, 2,
      `cdn.explain.${v} is missing from a dictionary`);
  }
});

check('the viewer probe is reachable from the panel', () => {
  assert.ok(/networks\/\$\{network\.id\}\/watch/.test(panelCode), 'nothing asks the edge as a viewer');
  // The stream used to be typed into a field beside the place that already
  // knew it. It comes from the channel now — same requirement, better source.
  assert.ok(/body: \{ application, stream \}/.test(panelCode),
    'the probe has no stream to ask for');
});

check('live mode refreshes and stops', () => {
  // An operator during a broadcast wants the tab answering, not a button to
  // keep pressing — and an interval that is never cleared is a leak.
  assert.ok(/setInterval/.test(panelCode), 'there is no live refresh');
  assert.ok(/clearInterval/.test(panelCode), 'the live refresh is never stopped');
});

console.log('\nTHE PREVIEW CLOSES ITS OWN LOOP:');

const gwSrc = stripComments(readFile(new URL('components/GatewayPanel.jsx', FRONT), 'utf8'));

check('the produced link can be checked without leaving the page', () => {
  // The panel produced a URL and the operator went to a player to find out
  // whether it worked. It can ask the same question itself.
  assert.ok(/networks\/\$\{network\.id\}\/watch/.test(gwSrc), 'the preview cannot check its own link');
});

check('the check asks about the edge that was actually chosen', () => {
  // Probing every node and showing the first answer would report on a machine
  // the viewer will never touch.
  assert.ok(/preview\?\.decision\?\.edge\?\.name/.test(gwSrc),
    'the check does not match its result to the chosen edge');
});

check('there is one player, not two', () => {
  // hls.js loading, the Safari native path, the lazy import and the error
  // wording only need to be right once.
  assert.ok(/import \{ HlsPlayer \} from '\.\/StreamPlayback\.jsx'/.test(gwSrc),
    'the gateway panel does not reuse the existing player');
  const own = readFile(new URL('components/StreamPlayback.jsx', FRONT), 'utf8');
  assert.ok(/export function HlsPlayer/.test(own), 'the player is not exported for reuse');
  assert.ok(!/hls\.js/.test(gwSrc), 'the gateway panel loads hls.js itself');
});

check('the player plays what the viewer would fetch', () => {
  // Under a redirect gateway the front URL 302s; feeding the front URL to a
  // player tests the redirect, not the media. The final target is what plays.
  assert.ok(/preview\.redirectsTo \|\| preview\.url/.test(gwSrc),
    'the player is given the front URL rather than the one the media comes from');
});

console.log(failures ? `\n${failures} delivery-plan check(s) failed` : '\nall delivery-plan checks passed');
process.exit(failures ? 1 : 0);
