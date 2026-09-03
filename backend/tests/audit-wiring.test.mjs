// What the audit middleware does, asked by running it.
//
// The gate this replaces asserted that `src/services/audit.js` contained the
// text `full.startsWith(prefix)`. It did. The rule it described had never
// fired: mounted at `/api`, the middleware compared `/api/agent-gw/logs`
// against a list of paths written without the mount prefix, and every agent
// poll was audited for as long as the rule existed. 29.4 million rows, 23.8 GB
// of a 96 GB disk, and a passing test the whole time.
//
// So this file mounts the real middleware the way `src/index.js` mounts it,
// sends real requests through a real Express app, and asserts on what would
// have been written. Nothing here reads source text.

import assert from 'node:assert/strict';
import express from 'express';
import { auditMutations, machineTrafficFilter, routeOf, MACHINE_ROUTES }
  from '../src/services/audit.js';
import { AuditLog } from '../src/models/AuditLog.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

// Every request the panel really receives, and what it should leave behind.
// `null` means no row at all.
const CASES = [
  { url: '/api/agent-gw/logs', method: 'POST', expect: null },
  { url: '/api/agent-gw/poll', method: 'POST', expect: null },
  { url: '/api/agent-gw/task/6a993c58/result', method: 'POST', expect: null },
  { url: '/api/agents/enroll', method: 'POST', expect: null },
  // Logged by the route itself, with an outcome this middleware cannot know.
  { url: '/api/auth/login', method: 'POST', expect: null },
  // Everything a person does is audited by default, not by being listed.
  { url: '/api/servers/abc/test', method: 'POST', expect: 'POST servers/abc/test' },
  { url: '/api/llhls/edges/abc/apply', method: 'POST', expect: 'POST llhls/edges/abc/apply' },
  { url: '/api/cdn/networks/6a79c568/state', method: 'POST', expect: 'POST cdn/networks/6a79c568/state' },
  // A query string is not part of the route.
  { url: '/api/servers/abc/test?force=1', method: 'POST', expect: 'POST servers/abc/test' },
  // Reads are not audited at all.
  { url: '/api/servers/abc/test', method: 'GET', expect: null },
];

// Drive the real middleware behind the real mount point and collect the rows
// it would have written.
async function run() {
  const written = [];
  const realCreate = AuditLog.create;
  AuditLog.create = async (doc) => { written.push(doc.action); return doc; };

  const app = express();
  app.use(express.json());
  // Exactly as src/index.js mounts it. This line is the whole point of the
  // file: the previous gate never executed it, and the bug lived here.
  app.use('/api', auditMutations);
  app.use((req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;

  const results = [];
  for (const c of CASES) {
    written.length = 0;
    await fetch(`http://127.0.0.1:${port}${c.url}`, {
      method: c.method,
      headers: { 'content-type': 'application/json' },
      body: c.method === 'GET' ? undefined : '{}',
    });
    // `finish` fires after the response; give the loop a turn.
    await new Promise(r => setTimeout(r, 20));
    results.push({ ...c, got: written.length ? written[0] : null, rows: written.length });
  }

  server.close();
  AuditLog.create = realCreate;
  return results;
}

console.log('\nTHE AUDIT MIDDLEWARE, MOUNTED AND RUN:');

const results = await run();

for (const r of results) {
  check(`${r.method} ${r.url} → ${r.expect === null ? 'no row' : r.expect}`, () => {
    assert.equal(r.got, r.expect,
      `wrote ${JSON.stringify(r.got)} where ${JSON.stringify(r.expect)} was expected`);
  });
}

check('nothing is written twice', () => {
  // `auth:login` 39 and `POST auth/login` 39 on the production panel: the same
  // event recorded by the route and by this middleware, because the skip
  // compared a path that had been rewritten by the time it was read.
  for (const r of results) {
    assert.ok(r.rows <= 1, `${r.method} ${r.url} wrote ${r.rows} rows`);
  }
});

console.log('\nTHE SKIP AND THE SWEEP AGREE ON ONE STRING:');

check('every action the middleware skips is one the sweep would remove', () => {
  // The two consumers of MACHINE_ROUTES used to apply it to different strings:
  // the skip to a URL carrying `/api`, the filter to a stored `action` that
  // does not. Both are now checked against the action that would have been
  // stored for a real request.
  const re = new RegExp(machineTrafficFilter().action.$regex);
  for (const c of CASES.filter(x => x.expect === null && x.method !== 'GET')) {
    const wouldStore = `${c.method} ${routeOf({ originalUrl: c.url })}`;
    if (c.url.includes('/auth/login')) continue; // skipped for a different reason
    assert.ok(re.test(wouldStore),
      `the middleware skips ${c.url} but the sweep would not remove "${wouldStore}"`);
  }
});

check('no action the middleware keeps is one the sweep would remove', () => {
  // The other direction, and the more expensive one to get wrong: a filter
  // that matched an operator's action would delete somebody's history.
  const re = new RegExp(machineTrafficFilter().action.$regex);
  for (const r of results.filter(x => x.expect !== null)) {
    assert.ok(!re.test(r.expect), `the sweep would remove "${r.expect}"`);
  }
});

check('the rows already in production are still swept by this filter', () => {
  // Verbatim from `db.auditlogs.aggregate([{$group:{_id:"$action"}}])` on the
  // production panel, 2026-09-03. Changing how the list is written must not
  // orphan 29 million rows that were stored under the old spelling.
  const re = new RegExp(machineTrafficFilter().action.$regex);
  for (const a of ['POST agent-gw/logs', 'POST agent-gw/poll', 'POST agent-gw/metrics']) {
    assert.ok(re.test(a), `"${a}" would survive a sweep`);
  }
  for (const a of ['auth:login', 'POST auth/login', 'agent:ssh-probe',
                   'POST cdn/networks/6a79c568ccb2269b67de54b1/state', 'streamtag:set']) {
    assert.ok(!re.test(a), `"${a}" is an operator action and the sweep would remove it`);
  }
});

check('the list stays a short list of machine routes, not an allow-list', () => {
  assert.ok(MACHINE_ROUTES.length <= 4,
    `${MACHINE_ROUTES.length} routes excluded — this is becoming an allow-list`);
  for (const e of MACHINE_ROUTES) {
    // Stored actions carry no leading slash and no `/api`. An entry written
    // with either would silently never match — which is the bug this file
    // exists for.
    assert.ok(!e.startsWith('/'), `"${e}" starts with a slash; stored actions do not`);
    assert.ok(!e.startsWith('api/'), `"${e}" carries the mount prefix; stored actions do not`);
  }
});

if (failures) { console.log(`\n${failures} audit-wiring check(s) failed`); process.exit(1); }
console.log('\nall audit-wiring checks passed');
