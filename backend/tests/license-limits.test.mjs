// Free edition: one server (HQ D-0029, R-0005), read from one place — src/license/limits.js.
//
// What must hold: the second server is refused with a sentence a person can act on; the first is
// not; a panel that already has more keeps them (the guard only counts, it never deletes); and both
// ways a server can appear — the form and the WMSPanel import — go through the same guard. The
// wiring half is read from the source, because a guard that exists and is not mounted passes every
// unit test (route-audit's lesson, twice).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FREE, getLicenseLimits, fits, refusal, mayAdd, withinLicense } from '../src/license/limits.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

// A response that records what the guard did.
const fakeRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const runGuard = async (guard) => {
  const res = fakeRes();
  let nexted = null;
  await guard({}, res, (err) => { nexted = err ?? true; });
  return { res, nexted };
};

console.log('\nTHE LIMIT:');

await check('without a licence the panel is Free with one server', () => {
  assert.equal(getLicenseLimits(), FREE);
  assert.equal(FREE.edition, 'free');
  assert.equal(FREE.max.servers, 1);
  assert.ok(Object.isFrozen(FREE) && Object.isFrozen(FREE.max), 'the limits can be changed at runtime');
});

await check('one server fits, two do not', () => {
  assert.equal(fits(FREE, 'servers', 1), true);
  assert.equal(fits(FREE, 'servers', 2), false);
});

console.log('\nTHE REFUSAL:');

await check('the refusal says «Редакция Free», the limit and what to do', () => {
  const r = refusal(FREE, 'servers');
  assert.match(r.message, /^Редакция Free: серверов — не больше 1\./);
  assert.match(r.message, /удалите лишний/);
  assert.match(r.message, /редакция Pro/);
  assert.equal(r.code, 'license_limit');
  assert.equal(r.resource, 'servers');
  assert.equal(r.limit, 1);
  assert.equal(r.edition, 'free');
});

await check('the sentence is in `error`, which is what the panel shows of a failed request', () => {
  // frontend/src/api.js: new Error(data?.error || …) — a code there would reach the operator raw.
  const r = refusal(FREE, 'servers');
  assert.equal(r.error, r.message);
});

console.log('\nTHE GUARD:');

await check('the first server is let through', async () => {
  const { res, nexted } = await runGuard(withinLicense('servers', async () => 0));
  assert.equal(nexted, true);
  assert.equal(res.body, null);
});

await check('the second server is refused with 403 and the Free sentence', async () => {
  const { res, nexted } = await runGuard(withinLicense('servers', async () => 1));
  assert.equal(nexted, null, 'the request reached the handler');
  assert.equal(res.code, 403);
  assert.match(res.body.error, /^Редакция Free/);
});

await check('a panel already over the limit is refused more, and only counted — nothing removed', async () => {
  // Fourteen edges, as the operator's own fleet: the guard asks how many there are and says no.
  const calls = [];
  const { res } = await runGuard(withinLicense('servers', async () => { calls.push('count'); return 14; }));
  assert.equal(res.code, 403);
  assert.deepEqual(calls, ['count']);
});

await check('a failing count is an error, not a free pass', async () => {
  const boom = new Error('db down');
  const { res, nexted } = await runGuard(withinLicense('servers', async () => { throw boom; }));
  assert.equal(nexted, boom);
  assert.equal(res.code, 200);
});

await check('an edition without a limit lets everything through without counting', async () => {
  let counted = false;
  const pro = () => ({ edition: 'pro', max: { servers: null } });
  const { nexted } = await runGuard(withinLicense('servers', async () => { counted = true; return 99; }, pro));
  assert.equal(nexted, true);
  assert.equal(counted, false);
});

await check('mayAdd answers the import the same way', async () => {
  assert.deepEqual(await mayAdd('servers', async () => 0), { ok: true });
  const no = await mayAdd('servers', async () => 1);
  assert.equal(no.ok, false);
  assert.match(no.refusal.message, /^Редакция Free/);
});

console.log('\nWIRING:');

await check('POST /api/servers is guarded, after the permission check and before the handler', () => {
  const src = read('routes/servers.js');
  const m = src.match(/serversRouter\.post\(\s*'\/'\s*,([^\n]*)/);
  assert.ok(m, 'no POST / on the servers router');
  const chain = m[1];
  const perm = chain.indexOf("requirePerm('servers.manage')");
  const lic = chain.indexOf("withinLicense('servers'");
  const handler = chain.indexOf('async (req');
  assert.ok(lic > perm && perm >= 0, 'the licence guard is missing or runs before the permission check');
  assert.ok(handler > lic, 'the licence guard runs after the handler');
});

await check('the WMSPanel import asks before it creates', () => {
  const src = read('services/wmspanelSync.js');
  const ask = src.indexOf("mayAdd('servers'");
  const create = src.indexOf('NimbleServer.create(');
  assert.ok(ask > 0, 'the import does not ask the licence');
  assert.ok(create > ask, 'the import creates before it asks');
});

await check('nothing else in the backend creates a server record', () => {
  const hits = [];
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.js') && /NimbleServer\.(create|insertMany)\(|new NimbleServer\(/.test(readFileSync(p, 'utf8'))) {
        hits.push(path.relative(SRC, p).split(path.sep).join('/'));
      }
    }
  })(SRC);
  assert.deepEqual(hits.sort(), ['routes/servers.js', 'services/wmspanelSync.js']);
});

await check('the limit is defined in one place', () => {
  const hits = [];
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.js') && /edition:\s*'free'/.test(readFileSync(p, 'utf8'))) hits.push(e);
    }
  })(SRC);
  assert.deepEqual(hits, ['limits.js']);
});

await check('the limits module never deletes', () => {
  assert.ok(!/delete|remove|drop/i.test(read('license/limits.js').replace(/\/\/.*$/gm, '')));
});

console.log(failures ? `\n${failures} licence-limit check(s) failed` : '\nall licence-limit checks passed');
process.exit(failures ? 1 : 0);
