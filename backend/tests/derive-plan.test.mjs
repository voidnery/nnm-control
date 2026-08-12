// Deriving instead of asking, iter21 m3.
//
// The panel grew a screen per Nimble primitive and the operator was the
// integration between them. These checks are about the reversal: intent goes
// in, primitives come out, and every one of them can say why it exists —
// because a panel that writes objects into an account silently is only
// acceptable if it can show its reasoning at any moment.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { derivePlan, channelReadiness } from '../src/services/derivePlan.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const SERVERS = [
  { _id: 'o', name: 'selectel(24/7)', host: '79.98.187.66', httpPort: 8081, wmspanelServerId: 'W-O' },
  { _id: 'e2', name: 'RU-2', host: '10.0.0.20', httpPort: 0, wmspanelServerId: 'W-E2' },
  { _id: 'e3', name: 'RU-3', host: '10.0.0.30', httpPort: 0, wmspanelServerId: 'W-E3' },
];
const NET = {
  nodes: [
    { id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true },
    { id: 'n-2', role: 'edge', server: 'e2', upstream: ['n-o'], enabled: true },
    { id: 'n-3', role: 'edge', server: 'e3', upstream: ['n-o'], enabled: true },
  ],
};
const CH = (application, stream) => ({ application, stream });

console.log('\nINTENT IN, PRIMITIVES OUT:');

check('one channel on two edges derives two routes', () => {
  // The operator said "deliver test2 here". They did not say "write a route
  // on RU-2 and another on RU-3", and they should not have to.
  const p = derivePlan({ network: NET, servers: SERVERS, channels: [CH('test2', 'main')] });
  assert.equal(p.summary.create, 2, JSON.stringify(p.items));
  assert.deepEqual(p.items.map(i => i.subject).sort(), ['RU-2', 'RU-3']);
});

check('two channels on one application derive one route each edge, not two', () => {
  // Routing is per application; two streams of the same application ride the
  // same route. Deriving two would try to create a duplicate and fail on the
  // second, which is a confusing way to say "already done".
  const p = derivePlan({ network: NET, servers: SERVERS, channels: [CH('test2', 'a'), CH('test2', 'b')] });
  assert.equal(p.summary.create, 2);
});

console.log('\nEVERY PRIMITIVE SAYS WHY IT EXISTS:');

check('each item carries a reason and its provenance', () => {
  // Not the fields — the reasoning. "A route on RU-2 so it can serve test2",
  // and where the port and address in it came from.
  const p = derivePlan({ network: NET, servers: SERVERS, channels: [CH('test2', 'main')] });
  for (const i of p.items) {
    assert.ok(i.why, 'an item with no reason');
    assert.ok(i.provenance?.origin, 'no origin recorded');
    assert.ok(i.provenance?.portSource, 'the port has no provenance');
  }
});

check('a guessed port is still labelled as guessed after deriving', () => {
  // The guess does not become a fact by passing through another layer.
  const p = derivePlan({ network: NET, servers: SERVERS, channels: [CH('test2', 'main')] });
  assert.equal(p.items[0].provenance.portSource, 'configured');
  const noPort = SERVERS.map(s => (s._id === 'o' ? { ...s, httpPort: 0 } : s));
  const q = derivePlan({ network: NET, servers: noPort, channels: [CH('test2', 'main')] });
  assert.equal(q.items[0].provenance.portSource, 'nimble-default');
});

console.log('\n"NOTHING TO DO" IS NOT "EVERYTHING IS BLOCKED":');

check('an account that already matches is in sync', () => {
  const existing = [
    { id: 'r1', from: '/test2/', to: '79.98.187.66:8081/test2/', servers: ['W-E2'] },
    { id: 'r2', from: '/test2/', to: '79.98.187.66:8081/test2/', servers: ['W-E3'] },
  ];
  const p = derivePlan({ network: NET, servers: SERVERS, channels: [CH('test2', 'main')], existingRoutes: existing });
  assert.equal(p.inSync, true);
  assert.equal(p.summary.keep, 2);
});

check('a blocked plan is not in sync even with nothing pending', () => {
  // Both produce zero pending items and they mean opposite things. An apply
  // button that counts items cannot tell them apart.
  const p = derivePlan({
    network: NET, servers: SERVERS, channels: [CH('blastdotakk', 'main')],
    originApps: [{ application: 'blastdotakk', server_ids: ['W-E2', 'W-E3'] }],
  });
  assert.ok(p.blocking.length);
  assert.equal(p.inSync, false);
});

console.log('\nA CHANNEL THE NETWORK CANNOT CARRY:');

check('it is named separately from a routing problem', () => {
  // There is nothing to route to, so the fix is a different one: give the
  // network an edge, not fix a route.
  const noEdges = { nodes: [{ id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true }] };
  const p = derivePlan({ network: noEdges, servers: SERVERS, channels: [CH('test2', 'main')] });
  assert.equal(p.items.length, 0);
  assert.equal(p.unservable.length, 1);
  assert.equal(p.unservable[0].channel, 'test2/main');
});

console.log('\nREADINESS PER CHANNEL:');

check('ready when everything for it is already written', () => {
  const existing = [
    { id: 'r1', from: '/test2/', to: '79.98.187.66:8081/test2/', servers: ['W-E2'] },
    { id: 'r2', from: '/test2/', to: '79.98.187.66:8081/test2/', servers: ['W-E3'] },
  ];
  const ch = CH('test2', 'main');
  const plan = derivePlan({ network: NET, servers: SERVERS, channels: [ch], existingRoutes: existing });
  assert.deepEqual(channelReadiness({ channel: ch, plan }), { code: 'ready', ready: true });
});

check('pending when something is still to be written', () => {
  const ch = CH('test2', 'main');
  const plan = derivePlan({ network: NET, servers: SERVERS, channels: [ch] });
  const r = channelReadiness({ channel: ch, plan });
  assert.equal(r.code, 'pending');
  assert.equal(r.pending, 2);
});

check('a channel with no edge to serve it says so, not "nothing planned"', () => {
  // Three states produce zero items and mean three different things: blocked,
  // unservable, and genuinely nothing to do.
  const noEdges = { nodes: [{ id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true }] };
  const ch = CH('test2', 'main');
  const plan = derivePlan({ network: noEdges, servers: SERVERS, channels: [ch] });
  assert.equal(channelReadiness({ channel: ch, plan }).code, 'unservable');
});

check('blocked is its own answer, not "pending"', () => {
  const ch = CH('blastdotakk', 'main');
  const plan = derivePlan({
    network: NET, servers: SERVERS, channels: [ch],
    originApps: [{ application: 'blastdotakk', server_ids: ['W-E2', 'W-E3'] }],
  });
  assert.equal(channelReadiness({ channel: ch, plan }).code, 'blocked');
});

console.log('\nONE ANSWER, NOT TWO:');

check('routes are planned by the existing planner, not reimplemented', () => {
  // Two answers to "which routes does this imply" would drift, and the drift
  // would be invisible until an apply did something the preview did not show.
  const src = readFileSync(new URL('../src/services/derivePlan.js', import.meta.url), 'utf8');
  assert.ok(/from '\.\/deliveryPlan\.js'/.test(src), 'the route planner is not reused');
  assert.ok(!/routeFrom|routeTo/.test(src), 'route URLs are being built here as well');
});
console.log('\nTHE PAGE STOPPED ASKING THE OPERATOR TO PLAN:');

const FRONT = new URL('../../frontend/src/', import.meta.url);
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const deliv = strip(readFileSync(new URL('components/DeliveryRoutesPanel.jsx', FRONT), 'utf8'));
const page = strip(readFileSync(new URL('pages/DistributionPage.jsx', FRONT), 'utf8'));
const app = strip(readFileSync(new URL('App.jsx', FRONT), 'utf8'));

check('the panel derives rather than asking for a plan', () => {
  assert.ok(/networks\/\$\{network\.id\}\/derived/.test(deliv), 'nothing reads the derived plan');
  assert.ok(/inSync/.test(deliv), 'the page cannot tell "nothing to do" from "not set up"');
});

check('the reasoning is one click away, not hidden', () => {
  // Writing into an account without asking each time is only acceptable while
  // the working can be shown at any moment.
  // State that starts closed and can be toggled, not a name: `const showWhy =
  // false` satisfies "showWhy exists" while making the reasoning unreachable,
  // which is the exact thing being prevented.
  assert.ok(/const \[showWhy, setShowWhy\] = useState\(false\)/.test(deliv),
    'the reasoning is not a fold that starts closed');
  assert.ok(/setShowWhy\(v => !v\)/.test(deliv), 'the reasoning cannot be opened');
  assert.ok(/cdn\.fromOrigin/.test(deliv) && /portSource/.test(deliv),
    'the derived items do not show where their address and port came from');
});

check('the account objects left the delivery page', () => {
  // Account-wide WMSPanel settings are not part of building a network, and
  // having them as a fourth tab made the page read as eight equal things.
  assert.ok(!/wmspanel\/abr/.test(page), 'the delivery page still loads ABR ladders');
  assert.ok(!/'objects'/.test(page), 'the objects tab is still there');
  assert.ok(/AccountObjectsPage/.test(app), 'the objects page is not routed');
  assert.ok(/account-objects/.test(app));
});

check('they are still reachable, and still used', () => {
  // Moved, not removed: the "this edge will not cache" finding reads exactly
  // this data.
  assert.ok(/nav\.objects/.test(app), 'the objects page is in no menu');
  const overview = readFileSync(new URL('../src/services/configOverview.js', import.meta.url), 'utf8');
  assert.ok(/originApps/.test(overview), 'nothing reads the origin applications any more');
});

console.log(failures ? `\n${failures} derive check(s) failed` : '\nall derive checks passed');
process.exit(failures ? 1 : 0);
