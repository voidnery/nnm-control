// Two views of one edge, iter24 m1.
//
// Everything the panel knew about an edge came from outside it. That answers
// "can a viewer get this" and stops — Nimble, the machine's firewall, the route
// between and the panel's own network all look identical from here, and they
// are four different repairs.
//
// These checks are about what the pair means, not about whether a fetch works.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcile, cacheFromInside } from '../src/services/insideOutside.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const inside = (status, moving = true) => ({ first: { status }, moving });

console.log('\nWHAT THE TWO VIEWS MEAN TOGETHER:');

check('serving and reachable is the only "ok"', () => {
  assert.equal(reconcile({ inside: inside(200), outside: { ok: true } }).verdict, 'ok');
});

check('a playlist that does not advance is not "ok"', () => {
  // 200 on a frozen playlist is the most convincing wrong answer this check
  // could give: the file exists, the request succeeds, the stream is dead.
  // Only the inside view watched it long enough to know.
  assert.equal(reconcile({ inside: inside(200, false), outside: { ok: true } }).verdict, 'stale');
});

check('serving but unreachable is named as a path problem', () => {
  // Nimble is fine. A firewall, a route or the wrong address is not, and
  // sending somebody to look at Nimble would waste the afternoon.
  const r = reconcile({ inside: inside(200), outside: { ok: false } });
  assert.equal(r.verdict, 'unreachable');
  assert.match(r.why, /firewall|route|address/);
});

check('not serving anywhere says which end it asked', () => {
  const r = reconcile({ inside: { first: { status: 404 } }, outside: { ok: false } });
  assert.equal(r.verdict, 'not-served');
  assert.match(r.why, /404/);
});

check('a combination that cannot happen is reported as such', () => {
  // The panel served and the machine not, for one stream, means the two checks
  // are asking different questions. Calling that a verdict about the machine
  // would be worse than saying nothing.
  const r = reconcile({ inside: { first: { status: 404 } }, outside: { ok: true } });
  assert.equal(r.verdict, 'contradictory');
  assert.match(r.why, /cannot both be true/);
});

check('no agent is a fact about the fleet, not a failure', () => {
  const r = reconcile({ inside: null, outside: { ok: true } });
  assert.equal(r.verdict, 'outside-only');
  assert.equal(r.servedInside, null);
});

console.log('\nCACHE, MEASURED WHERE IT CAN BE:');

check('amplification is the figure, because Nimble has no hit counters', () => {
  // Confirmed against a live fleet: RamCacheSize, FileCacheSize and their
  // maxima, and nothing that counts a hit or a miss. Bytes out over bytes in
  // is the only effectiveness measure available.
  const c = cacheFromInside({ OutBytes: 1000, InBytes: 100, RamCacheSize: 100, MaxRamCacheSize: 500 });
  assert.equal(c.measured, true);
  assert.equal(c.amplification, 10);
  assert.equal(c.caching, true);
});

check('an idle edge is not measured and not called broken', () => {
  // A pull cache with no viewers pulls nothing. That is health, and reporting
  // it as a cache failure is the conflation this whole file exists to avoid.
  const c = cacheFromInside({ OutBytes: 0, InBytes: 0, RamCacheSize: 0, MaxRamCacheSize: 500 });
  assert.equal(c.measured, false);
  assert.match(c.why, /idle edge is normal/);
});

check('an edge serving about what it pulls is not caching', () => {
  const c = cacheFromInside({ OutBytes: 105, InBytes: 100, RamCacheSize: 10, MaxRamCacheSize: 500 });
  assert.equal(c.measured, true);
  assert.equal(c.caching, false);
});

check('occupancy survives when traffic cannot be measured', () => {
  // How full the cache is comes from different fields than how well it works,
  // and losing both because one is absent would throw away a real reading.
  const c = cacheFromInside({ RamCacheSize: 200, MaxRamCacheSize: 500 });
  assert.equal(c.measured, false);
  assert.equal(c.occupancy.percent, 40);
});

check('nothing at all is refused rather than reported as zero', () => {
  assert.equal(cacheFromInside(null).measured, false);
  assert.equal(cacheFromInside({}).occupancy, null);
});

console.log('\nTHE INSIDE VIEW IS ASKED PROPERLY:');

const agent = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
const probe = readFileSync(new URL('../src/services/channelProbe.js', import.meta.url), 'utf8');

check('the agent reads the playlist twice before calling it live', () => {
  // One fetch cannot tell a live stream from a file left behind by a dead one.
  const body = agent.slice(agent.indexOf("'POST /nimble/delivery'"), agent.indexOf("'POST /nimble/delivery'") + 4000);
  assert.ok(/out\.second = await read\(\)/.test(body), 'it reads once and calls it served');
  assert.ok(/EXT-X-MEDIA-SEQUENCE/.test(body), 'it compares something other than the media sequence');
});

check('it asks Nimble over loopback, which is the whole point', () => {
  const body = agent.slice(agent.indexOf("'POST /nimble/delivery'"), agent.indexOf("'POST /nimble/delivery'") + 4000);
  assert.ok(/127\.0\.0\.1/.test(body), 'it dials the machine by its public address');
});

check('the probe only asks agents that can answer', () => {
  // The route arrived in v29. Asking an older agent produces a task it will
  // never claim and a timeout that reads as a broken edge.
  assert.ok(/version \?\? 0\) >= 29/.test(probe), 'it asks agents that have no such route');
  assert.ok(/agentIsLive\(srv\)/.test(probe), 'it asks machines that are not answering');
});

check('a failed inside check does not fail the outside one', () => {
  // The panel's own reading is what it has always had, and losing it because
  // an agent stumbled would be a step backwards.
  assert.ok(/\.catch\(e => \(\{ first: \{ status: null/.test(probe),
    'an agent error throws out of the whole probe');
});

console.log('\nTHE RECONNAISSANCE SCRIPT ONLY LOOKS:');

const reconRaw = readFileSync(new URL('../tools/wms-recon.mjs', import.meta.url), 'utf8');
// Code, not prose. A comment explaining why `.lean()` is wrong is not a call
// to it — and flagging one is how a check starts firing on the documentation
// written to prevent the fault. Third time this exact distinction has been
// needed.
const recon = reconRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

check('it cannot write, by having no way to', () => {
  // A script that probes an API by permutation is a script that eventually
  // POSTs something. This one asks a named list of paths, and there is no
  // code path that sends a method or a body at all.
  for (const verb of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.ok(!new RegExp(`'${verb}'`).test(recon), `the script can send ${verb}`);
  }
  assert.ok(!/body:/.test(recon), 'the script can send a body');
});

check('the paths it asks about are named, not generated', () => {
  const list = /const PROBES = \[([\s\S]*?)\n\];/.exec(recon);
  assert.ok(list, 'the probe list is not a literal');
  assert.ok(!/for \(|map\(|\.\.\./.test(list[1]), 'the paths are built rather than written down');
});

check('it reads credentials through the models, which decrypt', () => {
  // `apiKey` is stored encrypted with the decryption on the schema getter.
  // Read through the driver, or through `.lean()`, it comes back as
  // ciphertext — every request returns 403 and the output reads as "the API
  // refuses us" when nothing had been asked properly.
  assert.ok(/from '\.\.\/src\/models\/Settings\.js'/.test(recon), 'it reads settings some other way');
  assert.ok(!/\.lean\(\)/.test(recon), 'a lean() read would skip the getters');
  const model = readFileSync(new URL('../src/models/Settings.js', import.meta.url), 'utf8');
  assert.ok(/apiKey:[^\n]*get: decryptField/.test(model),
    'the key is no longer decrypted by a getter — this reasoning needs rechecking');
});

check('it carries a control probe, so a blanket failure is legible', () => {
  // If the server itself cannot be read, the credentials or the IP allow-list
  // are the problem and nothing else in the output means anything.
  assert.ok(/a control probe/.test(recon), 'a total failure would look like a missing feature');
});

check('it lives where its dependencies resolve', () => {
  // Under backend/, because mongoose and the panel's models are in
  // backend/node_modules and backend/src — from the repository root neither
  // resolves, and the script died on its import before reaching anything.
  const here = new URL('../tools/wms-recon.mjs', import.meta.url).pathname;
  assert.ok(here.includes('/backend/tools/'), `the script sits at ${here}`);
});

console.log(failures ? `\n${failures} inside/outside check(s) failed` : '\nall inside/outside checks passed');
process.exit(failures ? 1 : 0);
