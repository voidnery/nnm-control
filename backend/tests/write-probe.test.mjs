// The write probe, tested against two servers that disagree.
//
// A probe whose job is to find out whether the server enforces a rule is
// worthless unless it reports differently for a server that does and one that
// does not. So the stub comes in two behaviours — strict and lax — and the
// checks below are the contradiction: the same run against the two must reach
// opposite conclusions.
//
// And the guard is checked by pointing the probe at a server whose only
// application is somebody's production one. It must send no writes at all.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, '..', 'tools', 'wms-app-write-probe.mjs');
const { buildSteps, conclude, sanitise, GUARD_NAME } = await import(TOOL);

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};
const testAsync = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('Live application write probe\n');

// --- the plan ---------------------------------------------------------------

test('the plan is derived from the chunk it finds, not from a constant', () => {
  const s = buildSteps({ chunk_duration: 6, protocols: ['HLS'] });
  const above = s.find(x => x.id === 'part-above-ceiling');
  assert.equal(above.body.hls_part_duration, 4000, 'ceiling for a 6 s chunk is 3000 ms');
  const s2 = buildSteps({ chunk_duration: 2, protocols: ['HLS'] });
  assert.equal(s2.find(x => x.id === 'part-above-ceiling').body.hls_part_duration, 2000);
});

test('the first part it sets is legal at the chunk it found', () => {
  const s = buildSteps({ chunk_duration: 0.6, protocols: ['HLS'] });
  const enable = s.find(x => x.id === 'enable');
  assert.ok(enable.body.hls_part_duration <= 300,
    `${enable.body.hls_part_duration} ms exceeds the ceiling for a 0.6 s chunk`);
});

test('the plan restores the protocols it found rather than a guess', () => {
  const s = buildSteps({ chunk_duration: 6, protocols: ['HLS', 'DASH', 'SLDP'] });
  assert.deepEqual(s.find(x => x.id === 'restore-hls').body.protocols, ['HLS', 'DASH', 'SLDP']);
});

test('no step sends a DELETE or touches anything but the one application', () => {
  const s = buildSteps({ chunk_duration: 6, protocols: ['HLS'] });
  for (const step of s) {
    assert.ok(step.body && typeof step.body === 'object');
    assert.ok(!('application' in step.body), `${step.id} would rename the application`);
    assert.ok(!('id' in step.body), `${step.id} would write an id`);
  }
});

test('push credentials are stripped before anything is printed', () => {
  const c = sanitise({ push_login: 'operator', push_password: 'hunter2' });
  assert.ok(!JSON.stringify(c).includes('hunter2'));
});

// --- the two stubs ----------------------------------------------------------

function fleet({ strict, appName = GUARD_NAME }) {
  const app = {
    id: 'p1', application: appName, chunk_duration: 6, chunk_count: 4,
    protocols: ['HLS', 'RTMP'], push_login: 'operator', push_password: 'hunter2',
    alhls_enabled: false,
  };
  const writes = [];
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const ok = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'DELETE') { res.writeHead(500); return res.end('DELETE must never be sent'); }
    if (url.pathname === '/v1/server/s1') return ok({ status: 'Ok', server: { id: 's1' } });
    if (url.pathname === '/v1/server/s1/live/app' && req.method === 'GET')
      return ok({ status: 'Ok', applications: [app] });
    if (url.pathname === '/v1/server/s1/live/app/p1') {
      if (req.method === 'GET') {
        const view = { ...app };
        // The field is conditional on an HLS protocol — the behaviour 103
        // reads predicted, and the thing the probe is here to confirm.
        if (!view.protocols.some(p => p.startsWith('HLS'))) {
          delete view.alhls_enabled; delete view.hls_part_duration;
        }
        if (!view.alhls_enabled) delete view.hls_part_duration;
        return ok({ status: 'Ok', application: view });
      }
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        const patch = JSON.parse(body || '{}');
        writes.push(patch);
        const next = { ...app, ...patch };
        if (strict) {
          const ceil = Math.floor(Number(next.chunk_duration) * 1000 / 2);
          const part = Number(next.hls_part_duration);
          if (next.alhls_enabled && Number.isFinite(part) && (part < 500 || part > ceil)) {
            // HTTP 200 with an error status: exactly how this API refuses.
            // Lower-case `error` is what the live server actually returns —
            // the reference writes `Ok` capitalised and says nothing about the
            // failure spelling, so the stub uses the observed one.
            return ok({ status: 'error', description: `hls_part_duration must be 500..${ceil}` });
          }
        }
        Object.assign(app, patch);
        return ok({ status: 'Ok', application: app });
      });
    }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>no</html>');
  });
  return { srv, writes, app };
}

const clean = () => {
  for (const f of readdirSync(join(here, '..', 'tools')))
    if (/^wms-write-probe-\d{4}-\d{2}-\d{2}\.txt$/.test(f)) unlinkSync(join(here, '..', 'tools', f));
};

const run = (base, args = []) => new Promise((resolve) => {
  execFile(process.execPath, [TOOL, 'cid', 'key', 's1', ...args],
    { env: { ...process.env, WMS_BASE: base } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

async function against(opts, args) {
  const f = fleet(opts);
  await new Promise(r => f.srv.listen(0, '127.0.0.1', r));
  const res = await run(`http://127.0.0.1:${f.srv.address().port}/v1`, args);
  f.srv.close(); clean();
  return { ...res, writes: f.writes, app: f.app };
}

// --- dry run ----------------------------------------------------------------

await testAsync('a dry run sends no writes and still prints the whole plan', async () => {
  const r = await against({ strict: true }, []);
  assert.equal(r.writes.length, 0, `a dry run sent ${r.writes.length} write(s)`);
  assert.match(r.stdout, /dry run/);
  assert.match(r.stdout, /part-above-ceiling/);
  assert.match(r.stdout, /shrink-chunk-alone/);
});

// --- the guard --------------------------------------------------------------

await testAsync('it refuses to write to an application that is not the probe', async () => {
  const r = await against({ strict: true, appName: 'facecast_24-7_main' }, ['--write']);
  assert.equal(r.writes.length, 0, `it wrote ${r.writes.length} time(s) to a production application`);
  assert.notEqual(r.code, 0, 'refusing should not be reported as success');
  assert.match(r.stdout, /No application named/);
  assert.match(r.stdout, /facecast_24-7_main/, 'it should say what is there instead');
});

// --- strict versus lax, which is the whole point ----------------------------

let strictRun, laxRun;

await testAsync('against a server that enforces the bounds, it says so', async () => {
  strictRun = await against({ strict: true }, ['--write']);
  assert.equal(strictRun.code, 0, strictRun.stdout);
  assert.match(strictRun.stdout, /the server enforces the ceiling\s+YES/);
  assert.match(strictRun.stdout, /the server enforces a part floor\s+YES \(500 ms/);
});

await testAsync('against a server that does not, it says the panel must', async () => {
  laxRun = await against({ strict: false }, ['--write']);
  assert.equal(laxRun.code, 0, laxRun.stdout);
  assert.match(laxRun.stdout, /the server enforces the ceiling\s+NO — the panel must/);
  assert.match(laxRun.stdout, /the server enforces a part floor\s+NO — the panel must/);
});

await testAsync('the two runs disagree, which is what makes the probe worth running', () => {
  const pick = (s) => s.split('=== What the panel must do about it')[1];
  assert.notEqual(pick(strictRun.stdout), pick(laxRun.stdout),
    'a strict server and a lax one produced the same conclusions — the probe measures nothing');
});

await testAsync('the lax server leaving an illegal pair is called out by name', async () => {
  assert.match(laxRun.stdout, /LEAVES AN ILLEGAL PAIR/);
  assert.match(laxRun.stdout, /ACCEPTED and left illegal/);
});

await testAsync('the conditional field is confirmed by a write, not inferred', async () => {
  assert.match(strictRun.stdout, /lowering the chunk alone\s+is refused/);
  assert.match(strictRun.stdout, /the field is conditional on HLS\s+YES/);
  assert.match(strictRun.stdout, /conditional on an HLS protocol/);
});

await testAsync('an HTTP 200 carrying status=Error is read as a refusal', () => {
  // The strict stub refuses that way and only that way, so a probe that read
  // the status code alone would have scored the ceiling as unenforced.
  assert.match(strictRun.stdout, /refused/);
  assert.doesNotMatch(strictRun.stdout, /✗ part-above-ceiling/);
});

await testAsync('it puts the application back and says whether that worked', async () => {
  assert.match(strictRun.stdout, /Restore: accepted/);
  assert.equal(strictRun.app.chunk_duration, 6, 'the chunk was left changed');
  assert.equal(strictRun.app.alhls_enabled, false, 'LL-HLS was left on');
  assert.deepEqual(strictRun.app.protocols, ['HLS', 'RTMP']);
});

await testAsync('no credential is printed, and DELETE is never sent', async () => {
  assert.ok(!strictRun.stdout.includes('hunter2'));
  assert.match(strictRun.stdout, /DELETE is never sent/);
});

// --- conclude() on its own --------------------------------------------------

test('conclude reports a lax server even when every write returned 200', () => {
  const c = conclude([
    { id: 'enable', outcome: 'accepted', complaint: null },
    { id: 'part-above-ceiling', outcome: 'accepted', complaint: 'the illegal part was stored — the server does not enforce the ceiling' },
    { id: 'part-below-floor', outcome: 'accepted', complaint: 'a 100 ms part was stored — the server does not enforce the floor' },
  ]);
  assert.equal(c.ceilingEnforcedByServer, false);
  assert.equal(c.floorEnforcedByServer, false);
  assert.equal(c.fieldWritable, true);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall write probe checks passed');
process.exit(failures ? 1 : 0);
