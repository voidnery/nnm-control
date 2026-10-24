// /healthz — what the Eterix update engine reads after an install (upd/0 P6): {ok, version, build, ts}.
// The engine compares `version` with the package it installed; a wrong number here is either a
// rollback that should not happen or a broken upgrade that is accepted.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInfo, healthz } from '../src/healthz.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const VERSION = readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};
const call = (handler) => {
  const r = { code: 200, body: null };
  handler({}, { status(c) { r.code = c; return this; }, json(b) { r.body = b; return this; } });
  return r;
};

console.log('\nTHE VERSION IT REPORTS:');

check('a development run reports package.json, which equals VERSION', () => {
  const info = buildInfo(new URL('file:///nonexistent/build-info.json'));
  assert.equal(info.version, VERSION);
  assert.equal(info.build, 'dev');
});

check('a packaged run reports what build.sh baked in', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nnm-healthz-'));
  const f = path.join(dir, 'build-info.json');
  writeFileSync(f, JSON.stringify({ version: '9.8.7', build: 'abc123def456' }));
  assert.deepEqual(buildInfo(pathToFileURL(f)), { version: '9.8.7', build: 'abc123def456' });
});

console.log('\nTHE ANSWER:');

check('a connected panel answers 200 with ok, version, build and ts', () => {
  const r = call(healthz({ info: { version: '1.2.3', build: 'b' }, dbReady: () => true }));
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.version, '1.2.3');
  assert.equal(r.body.build, 'b');
  assert.ok(!Number.isNaN(Date.parse(r.body.ts)), 'ts is not a timestamp');
});

check('a panel without its database answers 503 and ok:false', () => {
  const r = call(healthz({ info: { version: '1.2.3', build: 'b' }, dbReady: () => false }));
  assert.equal(r.code, 503);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.version, '1.2.3');
});

check('the body is the shape postinst waits for', () => {
  // packaging/eterix/debian/postinst matches *"ok":true*"version":"X.Y.Z"* on the raw body.
  const raw = JSON.stringify(call(healthz({ info: { version: VERSION, build: 'b' }, dbReady: () => true })).body);
  assert.match(raw, new RegExp(`"ok":true.*"version":"${VERSION.replace(/\./g, '\\.')}"`));
});

console.log('\nTHE PATH TO IT:');

check('the API mounts /healthz', () => {
  assert.match(readFileSync(path.join(ROOT, 'backend/src/index.js'), 'utf8'), /app\.get\('\/healthz',\s*healthz\(\)\)/);
});

check('nginx passes /healthz to the API instead of answering it with the SPA', () => {
  const conf = readFileSync(path.join(ROOT, 'frontend/nginx/default.conf.template'), 'utf8');
  const loc = conf.match(/location\s*=\s*\/healthz\s*\{([^}]*)\}/);
  assert.ok(loc, 'no exact location for /healthz — try_files would answer 200 with index.html');
  assert.match(loc[1], /proxy_pass\s+http:\/\/backend:4000\/healthz;/);
  assert.ok(conf.indexOf('location = /healthz') < conf.indexOf('location / {'));
});

console.log(failures ? `\n${failures} healthz check(s) failed` : '\nall healthz checks passed');
process.exit(failures ? 1 : 0);
