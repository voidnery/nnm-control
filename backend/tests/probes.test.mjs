// Channel measurement, iter20 m4.
//
// The rules that matter here are about what the panel is allowed to claim. It
// is not on the paths it reports, so every number must come from a node that
// is — and where none can be asked, the answer is a gap with a reason, never a
// measurement taken from somewhere else and labelled as if it came from there.
import assert from 'node:assert/strict';
import { runProbes, matrixTargets, classifyReferenceResults, cell, PROBE_MIN_AGENT }
  from '../src/services/probeService.js';
import { REFERENCE_POINTS, pointsNear, distanceKm } from '../src/services/referencePoints.js';

let failures = 0;
const check = (name, fn) => {
  try { const r = fn(); if (r instanceof Promise) return r.then(
    () => console.log(`  ✓ ${name}`),
    e => { console.log(`  ✗ ${name}: ${e.message}`); failures++; }); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const NODES = [
  { id: 'o', name: 'selectel(24/7)', host: '79.98.187.66', port: 8081, agentLive: true, agentEnabled: true, agentVersion: 20 },
  { id: 'e2', name: 'Nimble RU-2', host: '10.0.0.20', port: 8081, agentLive: false, agentEnabled: false, agentVersion: null },
  { id: 'e3', name: 'Nimble RU-3', host: '10.0.0.30', port: 8081, agentLive: true, agentEnabled: true, agentVersion: 20 },
];

console.log('\nWHO IS ASKED, AND WHAT ABOUT:');

check('every node is asked about every other node, on the streaming port', () => {
  const m = matrixTargets(NODES);
  assert.equal(m.get('o').length, 2);
  assert.ok(m.get('o').every(t => t.port === 8081));
  assert.ok(!m.get('o').some(t => t.id === 'node:o'), 'a node is not asked to reach itself');
});

console.log('\nA PATH THE PANEL IS NOT ON IS NOT GUESSED:');

await check('a node with no agent is a gap with a reason, not a number', async () => {
  // The panel could reach 10.0.0.20 itself and produce a plausible latency.
  // It would be the panel's latency to that box, presented as the edge's —
  // the same shape of answer to a different question.
  const asked = [];
  const { rows, skipped } = await runProbes({
    nodes: NODES, targetsByNode: matrixTargets(NODES),
    ask: async (from, targets) => {
      asked.push(from.name);
      return { results: targets.map(t => ({ id: t.id, attempts: 3, okCount: 3, minMs: 10, avgMs: 11, maxMs: 12 })) };
    },
  });
  assert.deepEqual(asked, ['selectel(24/7)', 'Nimble RU-3'], 'the agentless node was asked anyway');
  assert.ok(skipped.some(s => s.node === 'Nimble RU-2' && s.code === 'no-agent'));
  assert.ok(!rows.some(r => r.fromNode.name === 'Nimble RU-2'));
});

await check('an agent that is enabled but silent is a different gap', async () => {
  // One is fixed by installing an agent, the other by looking at one that is
  // already there.
  const nodes = NODES.map(n => (n.id === 'e2' ? { ...n, agentEnabled: true, agentLive: false } : n));
  const { skipped } = await runProbes({ nodes, targetsByNode: matrixTargets(nodes), ask: async () => ({ results: [] }) });
  assert.ok(skipped.some(s => s.code === 'agent-not-answering'));
});

await check('an agent too old to probe says so instead of failing', async () => {
  // The fleet is never uniformly upgraded. "No handler for POST /probe" from a
  // v19 agent must not read as a broken network.
  const nodes = NODES.map(n => (n.id === 'e3' ? { ...n, agentVersion: PROBE_MIN_AGENT - 1 } : n));
  const { skipped } = await runProbes({ nodes, targetsByNode: matrixTargets(nodes), ask: async () => ({ results: [] }) });
  const s = skipped.find(x => x.code === 'agent-too-old');
  assert.ok(s, JSON.stringify(skipped));
  assert.equal(s.need, PROBE_MIN_AGENT);
});

await check('one node failing does not lose the others', async () => {
  const { rows, skipped } = await runProbes({
    nodes: NODES, targetsByNode: matrixTargets(NODES),
    ask: async (from, targets) => {
      if (from.id === 'o') throw new Error('task timed out');
      return { results: targets.map(t => ({ id: t.id, attempts: 3, okCount: 3, minMs: 5, avgMs: 5, maxMs: 5 })) };
    },
  });
  assert.ok(skipped.some(s => s.code === 'probe-failed'));
  assert.ok(rows.some(r => r.fromNode.id === 'e3'));
});

console.log('\nREADING A MEASUREMENT:');

check('a spread is reported, not an average that hides it', () => {
  // 12ms four times and 900ms once is not a 190ms path, and the average is
  // exactly the number that makes it look like one.
  const c = cell(NODES[0], NODES[2], { attempts: 5, okCount: 5, minMs: 12, avgMs: 189.6, maxMs: 900 });
  assert.equal(c.jitterMs, 888);
  assert.equal(c.minMs, 12);
});

check('partial answers become loss, not silence', () => {
  const c = cell(NODES[0], NODES[2], { attempts: 4, okCount: 3, minMs: 10, avgMs: 11, maxMs: 12 });
  assert.equal(c.lossPct, 25);
  assert.equal(c.ok, true);
});

check('a target that never answered has no loss figure', () => {
  // 100% loss and "we never got a connection" look alike and are not: one is a
  // quality reading, the other is reachability.
  const c = cell(NODES[0], NODES[2], { attempts: 3, okCount: 0, error: 'ECONNREFUSED' });
  assert.equal(c.ok, false);
  assert.equal(c.avgMs, null);
  assert.equal(c.error, 'ECONNREFUSED');
});

check('an unmeasured cell carries nulls, never zeros', () => {
  const c = cell(NODES[0], NODES[2], null);
  assert.equal(c.avgMs, null);
  assert.equal(c.lossPct, null);
  assert.equal(c.ok, false);
});

console.log('\nTHE REFERENCE LIST IS SUSPECT BEFORE THE INTERNET IS:');

check('a point that fails from every node is flagged as our own stale entry', () => {
  const rows = [
    { pointId: 'ubuntu-xx', label: 'Mirror, Nowhere', country: 'XX', ok: false },
    { pointId: 'ubuntu-xx', label: 'Mirror, Nowhere', country: 'XX', ok: false },
    { pointId: 'ubuntu-de', label: 'Mirror, Germany', country: 'DE', ok: true },
    { pointId: 'ubuntu-de', label: 'Mirror, Germany', country: 'DE', ok: false },
  ];
  const { suspect } = classifyReferenceResults(rows, { probedNodes: 2 });
  assert.equal(suspect.length, 1);
  assert.equal(suspect[0].pointId, 'ubuntu-xx');
});

check('a point failing from one node of two is not blamed on the list', () => {
  const rows = [
    { pointId: 'ubuntu-de', ok: true }, { pointId: 'ubuntu-de', ok: false },
  ];
  assert.equal(classifyReferenceResults(rows, { probedNodes: 2 }).suspect.length, 0);
});

console.log('\nCHOOSING WHERE TO MEASURE TOWARDS:');

check('distance is great-circle, not coordinate arithmetic', () => {
  // Frankfurt to Tokyo is about 9,300 km. Subtracting coordinates gives a
  // number that is wrong everywhere except near the equator.
  const d = distanceKm({ lat: 50.11, lon: 8.68 }, { lat: 35.68, lon: 139.75 });
  assert.ok(Math.abs(d - 9300) < 400, `got ${Math.round(d)} km`);
});

check('a point inside the country beats a closer one across the border', () => {
  // Clicking Germany should measure to Germany even though Amsterdam is
  // nearer to the western edge of it than Frankfurt is.
  const near = pointsNear({ lat: 51.5, lon: 6.5, country: 'DE' }, { limit: 2 });
  assert.equal(near[0].country, 'DE');
});

check('with no country, the nearest points are offered anyway', () => {
  const near = pointsNear({ lat: 55.75, lon: 37.62 }, { limit: 3 });
  assert.equal(near.length, 3);
  assert.ok(near[0].distanceKm <= near[1].distanceKm);
});

check('every reference point carries a country and a position', () => {
  for (const p of REFERENCE_POINTS) {
    assert.ok(/^[A-Z]{2}$/.test(p.country), `${p.id} has no ISO country`);
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `${p.id} has no position`);
    assert.ok(p.port > 0, `${p.id} has no port`);
  }
});

check('no anycast resolver is in the list', () => {
  // 1.1.1.1 answers from whichever site is nearest the prober, so measuring
  // "towards Germany" against it measures nothing about Germany.
  const banned = ['1.1.1.1', '8.8.8.8', '9.9.9.9', 'dns.google', 'one.one.one.one'];
  for (const p of REFERENCE_POINTS) assert.ok(!banned.includes(p.host), `${p.host} is anycast`);
});

console.log(failures ? `\n${failures} probe check(s) failed` : '\nall probe checks passed');
process.exit(failures ? 1 : 0);
