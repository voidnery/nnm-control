// The applications recon script, tested before it is run on somebody's fleet.
//
// A reconnaissance script gets one run on a machine that is not ours, and its
// output is then believed. So the two things that decide whether the output is
// worth believing are checked here against a stub WMSPanel:
//
//   - the verdict logic, which is what the report actually says;
//   - the removal of push credentials, because the report is a file that gets
//     pasted into a chat window.
//
// Each check is proven by contradiction where it can be: the fixture that
// should produce a warning is compared against a neighbour that should not.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, '..', 'tools', 'wms-apps-recon.mjs');
const { assess, sanitise } = await import(TOOL);

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};
const testAsync = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('Applications recon\n');

// --- the part-duration ceiling ---------------------------------------------
// The whole reason this recon exists: at the default chunk of 6 seconds the
// ceiling is 3000 ms, and a 3000 ms part is not low latency.

test('a 6-second chunk reports its hold-back rather than being scolded', () => {
  // This used to assert that a 3000 ms part was "not low latency". The vendor
  // recommends 2000 ms at exactly this chunk, so the complaint was firing on a
  // correct configuration and has been replaced by the derived hold-back.
  const a = assess({ application: 'x', chunk_duration: 6, protocols: ['HLS', 'HLS_FMP4'],
                     alhls_enabled: true, hls_part_duration: 2000 });
  assert.equal(a.ceiling, 3000);
  assert.equal(a.verdict, 'on');
  assert.ok(!a.notes.some(n => /not low latency/.test(n)));
  assert.ok(a.notes.some(n => /HOLD-BACK 6s/.test(n)), JSON.stringify(a.notes));
});

test('a 1-second chunk with a 500 ms part draws no complaint but the container one', () => {
  const a = assess({ application: 'x', chunk_duration: 1, protocols: ['HLS_FMP4'],
                     alhls_enabled: true, hls_part_duration: 500 });
  assert.equal(a.ceiling, 500);
  assert.deepEqual(a.notes.filter(n => !/HOLD-BACK/.test(n)), [],
    `a correct configuration was warned about: ${JSON.stringify(a.notes)}`);
});

test('a chunk too short for any legal part is blocked, not offered', () => {
  const a = assess({ application: 'x', chunk_duration: 0.4, protocols: ['HLS'],
                     alhls_enabled: false });
  assert.equal(a.verdict, 'blocked by chunk');
  assert.ok(a.notes.some(n => /below the 500 ms floor/.test(n)));
});

test('the fleet\'s plain-HLS container is flagged for video, not silently blessed', () => {
  const a = assess({ application: 'x', chunk_duration: 6, protocols: ['HLS', 'RTMP'],
                     alhls_enabled: false });
  assert.ok(a.notes.some(n => /HLS_FMP4/.test(n)),
    'every application in the fleet is on the audio-optimised container and nothing said so');
});

test('a part above the ceiling is reported as the server contradicting itself', () => {
  const a = assess({ application: 'x', chunk_duration: 2, protocols: ['HLS'],
                     alhls_enabled: true, hls_part_duration: 1500 });
  assert.ok(a.notes.some(n => /exceeds the ceiling/.test(n)),
    'a part longer than half the chunk was accepted silently');
});

// --- protocols --------------------------------------------------------------

test('an application with no HLS is n/a rather than off', () => {
  const a = assess({ application: 'x', chunk_duration: 6, protocols: ['RTMP', 'SLDP'] });
  assert.equal(a.verdict, 'field absent');   // no alhls_enabled key at all
  assert.ok(a.notes.some(n => /does not apply/.test(n)));
});

test('an off application that could be turned on says so', () => {
  const a = assess({ application: 'x', chunk_duration: 2, protocols: ['HLS', 'DASH'],
                     alhls_enabled: false });
  assert.equal(a.verdict, 'off, can be turned on');
});

test('the forbidden HLS + HLS_MPEGTS pair is not smoothed over', () => {
  const a = assess({ application: 'x', chunk_duration: 2,
                     protocols: ['HLS', 'HLS_MPEGTS'], alhls_enabled: false });
  assert.ok(a.notes.some(n => /forbids/.test(n)));
});

test('a missing chunk_duration is a missing fact, not a zero', () => {
  const a = assess({ application: 'x', protocols: ['HLS'], alhls_enabled: false });
  assert.equal(a.ceiling, null);
  assert.ok(a.notes.some(n => /cannot be computed/.test(n)),
    'an absent chunk_duration was treated as a number');
});

// --- credentials ------------------------------------------------------------

test('push credentials never survive into the report', () => {
  const clean = sanitise({ application: 'x', push_login: 'operator', push_password: 'hunter2' });
  const text = JSON.stringify(clean);
  assert.ok(!text.includes('hunter2'), 'the password is still in the object');
  assert.ok(!text.includes('operator'), 'the login is still in the object');
  assert.match(clean.push_password, /^<set, 7 chars>$/);
});

test('an empty credential is distinguishable from a set one', () => {
  const clean = sanitise({ push_login: '', push_password: '' });
  assert.equal(clean.push_login, '<empty>');
});

// --- end to end against a stub ---------------------------------------------
// The verdict logic can be right while the script still reports nothing
// useful, so the whole thing is run once against a fake WMSPanel.

const APPS = [
  { id: 'a1', application: 'live', chunk_duration: 6, chunk_count: 4,
    protocols: ['HLS', 'DASH'], push_login: 'operator', push_password: 'hunter2',
    alhls_enabled: false, some_new_field: 'from a newer panel' },
  { id: 'a2', application: 'lowlat', chunk_duration: 1, chunk_count: 6,
    protocols: ['HLS_FMP4'], alhls_enabled: true, hls_part_duration: 500,
    push_login: '', push_password: '' },
];

function stub() {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' });
                          res.end(JSON.stringify(o)); };
    if (req.method !== 'GET') { res.writeHead(500); return res.end('the script must not write'); }
    if (url.pathname === '/v1/server') return send({ status: 'Ok', servers: [{ id: 's1', name: 'edge-1' }] });
    if (url.pathname === '/v1/server/s1') return send({ status: 'Ok', server: { id: 's1' } });
    if (url.pathname === '/v1/server/s1/live/app') return send({ status: 'Ok', applications: APPS });
    if (url.pathname === '/v1/server/s1/live/app/a1') return send({ status: 'Ok', application: APPS[0] });
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>page does not exist</html>');
  });
}

// `--full` on purpose: without it the application JSON is never printed, so a
// masking check against this run would pass no matter what sanitise() did.
// That is exactly what happened the first time this file was written.
const run = (base) => new Promise((resolve) => {
  execFile(process.execPath, [TOOL, 'cid', 'key', '--full'], { env: { ...process.env, WMS_BASE: base } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

const server = stub();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const r = await run(base);
server.close();

// The report is written beside the tool; remove it so a test run leaves
// nothing behind.
for (const f of readdirSync(join(here, '..', 'tools'))) {
  if (/^wms-apps-\d{4}-\d{2}-\d{2}\.txt$/.test(f)) unlinkSync(join(here, '..', 'tools', f));
}

await testAsync('a whole run reads the fleet and exits clean', () => {
  assert.equal(r.code, 0, `the script failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /edge-1/);
  assert.match(r.stdout, /2 application\(s\) read/);
});

await testAsync('the report names the field this deployment has that the docs do not', () => {
  assert.match(r.stdout, /some_new_field/,
    'an undocumented field was returned and the census did not mention it');
});

await testAsync('the report says which documented fields never appeared', () => {
  assert.match(r.stdout, /Documented and never returned here:/);
  assert.match(r.stdout, /dash_template/, 'a field absent from the fixture was not listed as missing');
});

await testAsync('no credential reaches stdout, which is what gets pasted', () => {
  assert.ok(!r.stdout.includes('hunter2'), 'the push password was printed');
  assert.ok(!r.stdout.includes('operator'), 'the push login was printed');
});

await testAsync('the item route is confirmed by reading, before anything writes to it', () => {
  assert.match(r.stdout, /the item route, read/);
  assert.match(r.stdout, /Item route.*: 200/);
});

await testAsync('the control probe failing stops the report claiming anything', async () => {
  // Contradiction: a server that answers 403 to everything must not produce a
  // report that reads as "applications are unavailable here".
  const s = createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/v1/server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'Ok', servers: [{ id: 's1', name: 'edge-1' }] }));
    }
    res.writeHead(403); res.end('forbidden');
  });
  await new Promise(k => s.listen(0, '127.0.0.1', k));
  const out = await run(`http://127.0.0.1:${s.address().port}/v1`);
  s.close();
  for (const f of readdirSync(join(here, '..', 'tools'))) {
    if (/^wms-apps-\d{4}-\d{2}-\d{2}\.txt$/.test(f)) unlinkSync(join(here, '..', 'tools', f));
  }
  assert.match(out.stdout, /nothing below this line is evidence/,
    'a 403 fleet produced a report that looked like a finding');
  assert.ok(!/404 with a working control probe/.test(out.stdout));
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall applications recon checks passed');
process.exit(failures ? 1 : 0);
